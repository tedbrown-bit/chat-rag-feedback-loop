"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKSPACE_SLUG = "my-workspace";
const API = "http://127.0.0.1:3001/api/v1";

const ROOT = __dirname;
const MEMORIES = path.resolve(ROOT, "..", "..", "MEMORIES");

const STATE_FILE = path.join(ROOT, "UAU.state.json");
const ERROR_FILE = path.join(ROOT, "UAU.ERROR.log");
const EVENT_FILE = path.join(ROOT, "UAU.log");
const LOCK_FILE = path.join(ROOT, "UAU.lock");

const STATE_VERSION = 3;

const ROLE_SLICE = 1800;
const ROLE_OVERLAP = 300;
const WHOLE_LIMIT = 5000;

const LOCK_STALE_MS = 10 * 60 * 1000;

fs.mkdirSync(MEMORIES, {
  recursive: true,
});


function log(file, message) {
  fs.appendFileSync(
    file,
    `${new Date().toISOString()} ${message}\n`,
    "utf8"
  );
}


function sha(text) {
  return crypto
    .createHash("sha256")
    .update(String(text), "utf8")
    .digest("hex");
}


function pad(value) {
  return String(value).padStart(2, "0");
}


function stamp(value) {
  const d = new Date(value);

  return (
    `${d.getFullYear()}-` +
    `${pad(d.getMonth() + 1)}-` +
    `${pad(d.getDate())} ` +
    `${pad(d.getHours())}:` +
    `${pad(d.getMinutes())}:` +
    `${pad(d.getSeconds())}`
  );
}


function fileStamp(value) {
  const d = new Date(value);

  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}_` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}`
  );
}


function agentText(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== "string") {
    return String(raw).trim() || null;
  }

  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    const candidates = [
      parsed?.text,
      parsed?.response,
      parsed?.content,
      parsed?.message?.content,
      parsed?.choices?.[0]?.message?.content,
    ];

    for (const value of candidates) {
      if (
        typeof value === "string" &&
        value.trim()
      ) {
        return value;
      }
    }
  } catch {
  }

  return raw;
}


/*
  AnythingLLM UI threads are not SIMMAP memory boundaries.

  All normal local UI chats for the same user remain one
  continuous UAU chain even when a new left-panel chat is opened.

  Developer API sessions remain separate.
  Real multi-user accounts remain separate.
*/

function chainKey(row) {
  if (row.api_session_id) {
    return `api:${row.api_session_id}`;
  }

  return `user:${row.user_id ?? "local"}`;
}


function freshState() {
  return {
    version: STATE_VERSION,
    initialized: false,
    chains: {},
  };
}


function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return freshState();
  }

  try {
    const old = JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        "utf8"
      )
    );

    if (
      old?.version === STATE_VERSION
    ) {
      return old;
    }


    /*
      Migrate old thread-keyed state.

      The highest pending row is the current local SIMMAP
      conversation boundary regardless of left-panel thread.
    */

    const sources =
      old?.conversations ||
      old?.chains ||
      {};

    const ids =
      Object.values(sources)
        .map(
          item =>
            Number(
              item?.pendingRowId
            )
        )
        .filter(Number.isFinite);


    return {
      version:
        STATE_VERSION,

      initialized:
        old?.initialized === true,

      chains:
        ids.length
          ? {
              "user:local": {
                pendingRowId:
                  Math.max(...ids),

                inflight:
                  null,
              },
            }
          : {},
    };

  } catch {
    return freshState();
  }
}


function saveState(state) {
  const temp =
    `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      state,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temp,
    STATE_FILE
  );
}


function acquireLock() {
  try {
    const fd =
      fs.openSync(
        LOCK_FILE,
        "wx"
      );

    fs.writeFileSync(
      fd,
      `${process.pid}\n${Date.now()}\n`,
      "utf8"
    );

    fs.closeSync(fd);

    return true;

  } catch (error) {
    if (
      error?.code !== "EEXIST"
    ) {
      throw error;
    }

    try {
      const age =
        Date.now() -
        fs.statSync(
          LOCK_FILE
        ).mtimeMs;

      if (
        age >
        LOCK_STALE_MS
      ) {
        fs.unlinkSync(
          LOCK_FILE
        );

        return acquireLock();
      }

    } catch {
    }

    return false;
  }
}


function releaseLock() {
  try {
    fs.unlinkSync(
      LOCK_FILE
    );
  } catch {
  }
}


function split(
  text,
  limit = ROLE_SLICE,
  overlap = ROLE_OVERLAP
) {
  if (
    text.length <= limit
  ) {
    return [text];
  }

  const output = [];

  let start = 0;

  while (
    start < text.length
  ) {
    let end =
      Math.min(
        start + limit,
        text.length
      );

    if (
      end < text.length
    ) {
      const newline =
        text.lastIndexOf(
          "\n",
          end
        );

      const space =
        text.lastIndexOf(
          " ",
          end
        );

      const cut =
        Math.max(
          newline,
          space
        );

      if (
        cut >
        start +
        Math.floor(
          limit * 0.6
        )
      ) {
        end = cut;
      }
    }

    output.push(
      text.slice(
        start,
        end
      )
    );

    if (
      end >= text.length
    ) {
      break;
    }

    start =
      Math.max(
        0,
        end - overlap
      );
  }

  return output;
}


function makeId(
  key,
  before,
  after,
  userBefore,
  agent,
  userAfter
) {
  return sha(
    [
      key,
      before.id,
      after.id,
      userBefore,
      agent,
      userAfter,
    ].join("\n")
  );
}


function canonical({
  id,
  workspace,
  key,
  before,
  after,
  userBefore,
  agent,
  userAfter,
}) {
  return [
    "SIMMAP MEMORY",
    "TYPE: UAU",

    `ID: ${id}`,

    `WORKSPACE: ${workspace.name}`,
    `WORKSPACE SLUG: ${workspace.slug}`,

    `CHAIN: ${key}`,

    `SOURCE ROWS: ${before.id} -> ${after.id}`,

    `THREAD BEFORE: ${before.thread_id ?? "main"}`,
    `THREAD AFTER: ${after.thread_id ?? "main"}`,

    `CLOSED: ${stamp(after.createdAt)}`,

    "",

    "USER BEFORE",
    `TIME: ${stamp(before.createdAt)}`,
    userBefore,

    "",

    "AGENT",
    `TIME: ${stamp(
      before.lastUpdatedAt ||
      before.createdAt
    )}`,
    agent,

    "",

    "USER AFTER",
    `TIME: ${stamp(after.createdAt)}`,
    userAfter,

    "",

    "UAU END",
    "",
  ].join("\n");
}


function fragmentHeader(
  id,
  key,
  before,
  after,
  label
) {
  return [
    "SIMMAP MEMORY FRAGMENT",
    "TYPE: UAU",

    `PARENT ID: ${id}`,
    `CHAIN: ${key}`,

    `SOURCE ROWS: ${before.id} -> ${after.id}`,
    `PART: ${label}`,

    "",
  ].join("\n");
}


function ragChildren({
  id,
  key,
  before,
  after,
  parent,
  userBefore,
  agent,
  userAfter,
}) {
  if (
    parent.length <=
    WHOLE_LIMIT
  ) {
    return [
      {
        label:
          "complete",

        text:
          parent,
      },
    ];
  }


  const beforeParts =
    split(userBefore);

  const agentParts =
    split(agent);

  const afterParts =
    split(userAfter);


  const output = [];


  /*
    Oversized USER BEFORE.

    Earlier slices remain tied to the parent.
    Final slice enters the actual sandwich.
  */

  for (
    let i = 0;
    i <
    beforeParts.length - 1;
    i++
  ) {
    const label =
      `user-before-${i + 1}-of-${beforeParts.length}`;

    output.push({
      label,

      text: [
        fragmentHeader(
          id,
          key,
          before,
          after,
          label
        ),

        "USER BEFORE",

        `SEGMENT: ${i + 1}/${beforeParts.length}`,

        beforeParts[i],

        "",

        "CONTINUES INTO SAME UAU PARENT",

        "",
      ].join("\n"),
    });
  }


  const beforeAnchor =
    beforeParts[
      beforeParts.length - 1
    ];

  const afterAnchor =
    afterParts[0];


  /*
    Oversized AGENT.

    Every agent slice is physically sandwiched by
    USER BEFORE and USER AFTER context.
  */

  for (
    let i = 0;
    i <
    agentParts.length;
    i++
  ) {
    const label =
      `sandwich-${i + 1}-of-${agentParts.length}`;

    output.push({
      label,

      text: [
        fragmentHeader(
          id,
          key,
          before,
          after,
          label
        ),

        "USER BEFORE",

        `SEGMENT: ${beforeParts.length}/${beforeParts.length}`,

        beforeAnchor,

        "",

        "AGENT",

        `SEGMENT: ${i + 1}/${agentParts.length}`,

        agentParts[i],

        "",

        "USER AFTER",

        `SEGMENT: 1/${afterParts.length}`,

        afterAnchor,

        "",

        "UAU SANDWICH",

        "",
      ].join("\n"),
    });
  }


  /*
    Oversized USER AFTER.

    First slice already closed the sandwich.
    Remaining slices stay attached to the same parent.
  */

  for (
    let i = 1;
    i <
    afterParts.length;
    i++
  ) {
    const label =
      `user-after-${i + 1}-of-${afterParts.length}`;

    output.push({
      label,

      text: [
        fragmentHeader(
          id,
          key,
          before,
          after,
          label
        ),

        "USER AFTER",

        `SEGMENT: ${i + 1}/${afterParts.length}`,

        afterParts[i],

        "",

        "CONTINUATION OF SAME UAU PARENT",

        "",
      ].join("\n"),
    });
  }


  return output;
}


function writeCanonical(
  before,
  after,
  id,
  text
) {
  const name =
    `UAU_` +
    `${fileStamp(before.createdAt)}` +
    `_to_` +
    `${fileStamp(after.createdAt)}` +
    `_` +
    `${id.slice(0, 12)}.md`;


  const target =
    path.join(
      MEMORIES,
      name
    );


  if (
    !fs.existsSync(
      target
    )
  ) {
    const temp =
      `${target}.tmp`;

    fs.writeFileSync(
      temp,
      text,
      "utf8"
    );

    fs.renameSync(
      temp,
      target
    );
  }


  return name;
}


function prismaClient() {
  if (
    !process.env.STORAGE_DIR
  ) {
    throw new Error(
      "AnythingLLM did not supply STORAGE_DIR."
    );
  }


  const modulePath =
    path.join(
      process.env.LOCALAPPDATA,
      "Programs",
      "AnythingLLM",
      "resources",
      "backend",
      "node_modules",
      "@prisma",
      "client"
    );


  const {
    PrismaClient,
  } =
    require(
      modulePath
    );


  const db =
    path.join(
      process.env.STORAGE_DIR,
      "anythingllm.db"
    );


  if (
    !fs.existsSync(
      db
    )
  ) {
    throw new Error(
      `AnythingLLM database not found: ${db}`
    );
  }


  const url =
    `file:${db.replace(
      /\\/g,
      "/"
    )}`;


  return new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
  });
}


async function apiKey(prisma) {
  const row =
    await prisma
      .api_keys
      .findFirst({
        where: {
          secret: {
            not: null,
          },
        },

        orderBy: {
          id: "desc",
        },
      });


  if (
    !row?.secret
  ) {
    throw new Error(
      "AnythingLLM has no Developer API key available for UAU ingestion."
    );
  }


  return row.secret;
}


async function ingest(
  key,
  child,
  id,
  after
) {
  const response =
    await fetch(
      `${API}/document/raw-text`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${key}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            textContent:
              child.text,

            addToWorkspaces:
              WORKSPACE_SLUG,

            metadata: {
              title:
                `SIMMAP_UAU_${id.slice(0, 12)}_${child.label}`,

              docAuthor:
                "SIMMAP",

              description:
                "Persistent USER-AGENT-USER memory",

              docSource:
                "SIMMAP UAU",

              chunkSource:
                `simmap://uau/${id}/${child.label}`,

              published:
                new Date(
                  after.createdAt
                ).getTime(),
            },
          }),
      }
    );


  const raw =
    await response.text();


  let body =
    null;


  try {
    body =
      raw
        ? JSON.parse(raw)
        : null;

  } catch {
  }


  if (
    !response.ok ||
    body?.success !== true
  ) {
    throw new Error(
      `AnythingLLM ingestion failed HTTP ${response.status}: ${raw.slice(0, 800)}`
    );
  }
}


function groupRows(rows) {
  const groups =
    new Map();


  for (
    const row of rows
  ) {
    if (
      typeof row.prompt !== "string" ||
      !row.prompt.trim() ||
      !agentText(row.response)
    ) {
      continue;
    }


    const key =
      chainKey(row);


    if (
      !groups.has(key)
    ) {
      groups.set(
        key,
        []
      );
    }


    groups
      .get(key)
      .push(row);
  }


  for (
    const group of
    groups.values()
  ) {
    group.sort(
      (a, b) =>
        Number(a.id) -
        Number(b.id)
    );
  }


  return groups;
}


async function publish(
  workspace,
  key,
  state,
  chainName,
  before,
  after
) {
  const userBefore =
    before.prompt;

  const agent =
    agentText(
      before.response
    );

  const userAfter =
    after.prompt;


  if (
    !userBefore?.trim() ||
    !agent?.trim() ||
    !userAfter?.trim()
  ) {
    return false;
  }


  const id =
    makeId(
      chainName,
      before,
      after,
      userBefore,
      agent,
      userAfter
    );


  const parent =
    canonical({
      id,
      workspace,

      key:
        chainName,

      before,
      after,

      userBefore,
      agent,
      userAfter,
    });


  const children =
    ragChildren({
      id,

      key:
        chainName,

      before,
      after,

      parent,

      userBefore,
      agent,
      userAfter,
    });


  const chain =
    state
      .chains[
        chainName
      ];


  /*
    Persist in-flight state before publication.

    If AnythingLLM or Windows dies halfway through,
    successful child records do not all get repeated.
  */

  if (
    !chain.inflight ||
    chain.inflight.cycleId !== id
  ) {
    chain.inflight = {
      cycleId:
        id,

      beforeRowId:
        before.id,

      afterRowId:
        after.id,

      completedChildren:
        [],
    };


    saveState(
      state
    );
  }


  /*
    Canonical physical memory is written FIRST.

    This is the complete verbatim parent UAU in:

    C:\SIMMAP\MEMORIES
  */

  const filename =
    writeCanonical(
      before,
      after,
      id,
      parent
    );


  /*
    RAG-facing representation goes into AnythingLLM.

    Small UAU = one complete document.
    Large UAU = UAU-aware overlapping child documents.
  */

  for (
    const child of children
  ) {
    if (
      chain
        .inflight
        .completedChildren
        .includes(
          child.label
        )
    ) {
      continue;
    }


    await ingest(
      key,
      child,
      id,
      after
    );


    chain
      .inflight
      .completedChildren
      .push(
        child.label
      );


    saveState(
      state
    );
  }


  log(
    EVENT_FILE,
    `PUBLISHED ${before.id}->${after.id} ${filename} RAG=${children.length}`
  );


  return true;
}


async function main() {
  if (
    !acquireLock()
  ) {
    return;
  }


  const prisma =
    prismaClient();


  try {
    const state =
      loadState();


    const workspace =
      await prisma
        .workspaces
        .findUnique({
          where: {
            slug:
              WORKSPACE_SLUG,
          },
        });


    if (
      !workspace
    ) {
      throw new Error(
        `Workspace '${WORKSPACE_SLUG}' not found.`
      );
    }


    const key =
      await apiKey(
        prisma
      );


    const rows =
      await prisma
        .workspace_chats
        .findMany({
          where: {
            workspaceId:
              workspace.id,
          },

          orderBy: {
            id:
              "asc",
          },
        });


    const groups =
      groupRows(
        rows
      );


    /*
      Very first deployment only:

      Existing historical chat remains raw staging.
      New UAU publication begins at the newest current row.
    */

    if (
      !state.initialized
    ) {
      for (
        const [
          name,
          group,
        ]
        of groups
      ) {
        if (
          group.length
        ) {
          state
            .chains[
              name
            ] = {
              pendingRowId:
                group[
                  group.length - 1
                ].id,

              inflight:
                null,
            };
        }
      }


      state.initialized =
        true;


      saveState(
        state
      );


      log(
        EVENT_FILE,
        `INITIALIZED chains=${Object.keys(state.chains).length}`
      );


      return;
    }


    for (
      const [
        name,
        group,
      ]
      of groups
    ) {
      if (
        !group.length
      ) {
        continue;
      }


      /*
        New user/API chain after UAU is already live.

        First row becomes its starting U/A.
      */

      if (
        !state.chains[name]
      ) {
        state
          .chains[
            name
          ] = {
            pendingRowId:
              group[0].id,

            inflight:
              null,
          };


        saveState(
          state
        );
      }


      const chain =
        state
          .chains[
            name
          ];


      const pending =
        group.findIndex(
          row =>
            Number(row.id) ===
            Number(
              chain.pendingRowId
            )
        );


      /*
        Chat was deliberately deleted/reset.

        Anchor on newest surviving row instead of resurrecting
        deleted material.
      */

      if (
        pending < 0
      ) {
        chain.pendingRowId =
          group[
            group.length - 1
          ].id;

        chain.inflight =
          null;


        saveState(
          state
        );


        log(
          EVENT_FILE,
          `REANCHORED ${name} row=${chain.pendingRowId}`
        );


        continue;
      }


      /*
        Each new USER row closes the prior U-A.

        row N:
          USER BEFORE
          AGENT

        row N+1:
          USER AFTER

        Then row N+1 becomes USER BEFORE for the next cycle.
      */

      for (
        let i =
          pending + 1;

        i <
        group.length;

        i++
      ) {
        const before =
          group[
            i - 1
          ];

        const after =
          group[i];


        const success =
          await publish(
            workspace,
            key,
            state,
            name,
            before,
            after
          );


        if (
          !success
        ) {
          break;
        }


        chain.pendingRowId =
          after.id;

        chain.inflight =
          null;


        saveState(
          state
        );
      }
    }

  } finally {
    await prisma
      .$disconnect()
      .catch(
        () => {}
      );


    releaseLock();
  }
}


main()
  .catch(
    error => {
      log(
        ERROR_FILE,

        (
          error?.stack ||
          error?.message ||
          String(error)
        )
          .replace(
            /\r?\n/g,
            " | "
          )
      );


      releaseLock();


      process.exitCode =
        1;
    }
  );