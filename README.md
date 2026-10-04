# chat-rag-feedback-loop

## Reference Implementation

This repo includes a working `UAU.js` version built for AnythingLLM. The **Sandwich Logic** itself can be used with other chat interfaces, but they need their own connection code to read the conversation and send completed UAU memories into that system’s RAG store.

# Solving Feedback Loops in Chat-Populated RAG Using **Sandwich Logic**

Chat-populated RAG uses varying levels of prompt-response cycles. Those cycles may be represented as individual turns, groups of turns, complete sessions, or larger conversational histories.

As agent responses accumulate, their sheer volume increases their candidacy for future retrieval. A poor or inappropriate response can then influence later responses, which are added back into the same pool. Repeated retrieval reinforces the pattern, creating an expanding positive feedback loop that progressively poisons the RAG pool.

Current approaches generally address the problem by reducing the retrieval value of agent responses after ingestion. This limits the influence of potentially bad agent output, but it also reduces the value of legitimate agent contributions.

**Sandwich Logic** takes the opposite approach by increasing the relative value of the user’s contribution within each conversational cycle.

A memory is published to RAG only after the following user message arrives and completes the USER–AGENT–USER sandwich.

Each memory is stored as:

**USER BEFORE → AGENT → USER AFTER**

The next user message closes the current memory and then becomes the opening user message of the next one:

**U1 – A1 – U2**  
**U2 – A2 – U3**  
**U3 – A3 – U4**

This keeps every agent response sandwiched between the user context that produced it and the user response that followed it.

Normal-sized exchanges are stored and ingested as one complete UAU record.

Oversized USER or AGENT entries are divided into smaller overlapping fragments using 1,800-character slices with 300-character overlap.

**LONG USER ENTRY**

For a long opening user entry:

**USER FRAGMENT 1**  
**USER FRAGMENT 2**  
**USER FRAGMENT 3 – AGENT – USER AFTER**

For a long closing user entry:

**USER BEFORE – AGENT – USER FRAGMENT 1**  
**USER FRAGMENT 2**  
**USER FRAGMENT 3**

The user fragments remain linked to the same complete exchange.

**LONG AGENT ENTRY**

A long AGENT response is divided into multiple sandwiches using the same surrounding user context:

**U1 – AGENT FRAGMENT 1 – U2**  
**U1 – AGENT FRAGMENT 2 – U2**  
**U1 – AGENT FRAGMENT 3 – U2**

Each agent fragment therefore enters retrieval with user context on both sides.

The entire unsplit USER–AGENT–USER exchange is preserved separately as one complete canonical memory. Chunking creates retrieval-sized representations without losing the contextual intent behind the exchange.

**Retrieval remains standard vector retrieval. Sandwich Logic changes what gets retrieved by attaching user context to agent content before embedding.**

Instead of trying to repair the RAG pool after ingestion, **Sandwich Logic** changes the structure of the memory before it enters the pool. The result amplifies conversational context and gives the user’s voice greater structural authority while preserving the agent contribution.
