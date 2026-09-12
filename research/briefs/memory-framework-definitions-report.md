# Verbatim Technical Definitions: LangGraph / LangMem / Zep-Graphiti / Letta

Researched via live docs. URL status checked (`-L`, followed redirects). Quotes are verbatim; `[...]` marks elision.

## A) LangGraph memory

**Working URLs:** `https://docs.langchain.com/oss/python/concepts/memory` (200), `https://docs.langchain.com/oss/python/langgraph/add-memory` (200), `https://docs.langchain.com/oss/python/langchain/short-term-memory` (200). All also serve `.md` (LLM-friendly).
**Failed:** `https://raw.githubusercontent.com/langchain-ai/langgraph/main/docs/docs/concepts/memory.md` → **404** (repo docs path moved; source is now `github.com/langchain-ai/docs`).

### A1. Short-term (checkpointer) vs long-term (store)

- "Short-term memory, or thread-scoped memory, tracks the ongoing conversation by maintaining message history within a session."
- "State is persisted to a database using a checkpointer so the thread can be resumed at any time."
- "Long-term memory stores user-specific or application-level data across sessions and is shared *across* conversational threads."
- "It can be recalled *at any time* and *in any thread*. Memories are scoped to any custom namespace, not just within a single thread ID."
- add-memory: "**Short-term** memory (thread-level persistence) enables agents to track multi-turn conversations."
- add-memory: "Use long-term memory to store user-specific or application-specific data across conversations." Code: `store = InMemoryStore()` then `graph = builder.compile(store=store)`.
- Phrase "long-term memory store" appears in LangMem, not LangGraph docs: "The next layer up depends on LangGraph's long-term memory store."

**Mechanics:** Short-term = graph state persisted per `thread_id` by a checkpointer (`InMemorySaver`, `PostgresSaver`, etc.); state is updated when the graph is invoked or a step completes and read at the start of each step. Long-term = JSON documents in a `BaseStore` under a custom `namespace` + `key`, recalled in any thread; the two are compiled separately (`compile(checkpointer=..., store=...)`).

### A2. Semantic / episodic / procedural + hot path vs background

- "Semantic memory, both in humans and AI agents, involves the retention of specific facts and concepts."
- "Episodic memory, in both humans and AI agents, involves recalling past events or actions."
- "Procedural memory, in both humans and AI agents, involves remembering the rules used to perform tasks."
- Table (concepts/memory): Semantic = "Facts"; Episodic = "Experiences"; Procedural = "Instructions".
- "There are two primary methods for agents to write memories: "in the hot path" and "in the background"."
- Hot path: "the process of reasoning about what to save to memory can impact agent latency."
- Hot path: "the agent must multitask between memory creation and its other responsibilities, potentially affecting the quantity and quality of memories created."
- Background: "It eliminates latency in the primary application, separates application logic from memory management, and allows for more focused task completion by the agent."
- Background timing: "Determining the frequency of memory writing becomes crucial, as infrequent updates may leave other threads without new context."

**Mechanics:** hot-path writes happen inside the agent loop (real-time, transparent, but adds latency, tool-choice complexity, and multitasking); background writes run as a separate task with no user-visible latency but need a trigger policy (timer, cron, manual).

### A3. Summarization node / summarize messages

- add-memory: "The problem with trimming or removing messages, as shown above, is that you may lose information from culling of the message queue. Because of this, some applications benefit from a more sophisticated approach of summarizing the message history using a chat model."
- add-memory: "Then, you can generate a summary of the chat history, using any existing summary as context for the next summary. This `summarize_conversation` node can be called after some number of messages have accumulated in the `messages` state key."
- langchain/short-term-memory: "Summarize earlier messages in the history and replace them with a summary."
- LangMem guide: "One effective strategy for handling this is to summarize earlier messages once they reach a certain threshold."
- LangMem guide: "SummarizationNode uses `summarize_messages` under the hood and automatically handles existing summary propagation."
- LangMem guide (loss-of-fidelity warning): "We recommend rendering the full, unmodified message history."

**Mechanics:** extend `MessagesState` with a `summary` key (or use LangMem's `SummarizationNode`, which stores into a `context` key); when a token threshold (`max_tokens_before_summary`) is crossed, the older messages are summarized with the running summary as context and the pre-summary messages are deleted (`RemoveMessage`), leaving `[summary_message] + remaining_messages`. Explicit information-loss warning is the "you may lose information from culling" line plus the recommendation to keep the unmodified history for display.

### A4. Profile storage for semantic memory; updating/deleting

- "Memories can be a single, continuously updated "profile" of well-scoped and specific information about a user, organization, or other entity (including the agent itself)."
- "A profile is generally just a JSON document with various key-value pairs you've selected to represent your domain."
- "When remembering a profile, you will want to make sure that you are **updating** the profile each time."
- "This can be become error-prone as the profile gets larger, and may benefit from splitting a profile into multiple documents or **strict** decoding [...]"
- Collection alternative: "The model must now *delete* or *update* existing items in the list, which can be tricky."
- LangMem: profiles example uses `enable_inserts=False` with comment "Profiles update in-place".
- LangMem API: `create_memory_manager(..., enable_updates: bool = True, enable_deletes: bool = False)` — "Whether to allow deleting existing memories that are outdated or contradicted by new information. Defaults to False."
- LangMem `create_memory_store_manager`: "The system automatically searches for relevant memories, extracts new information, updates existing memories, and maintains a versioned history of all changes."

**Mechanics:** profiles are single upserted documents (best for latest state, easy manual editing); collections are append/update/delete lists (higher recall, but the model must reconcile, and can over-insert or over-update). Deletion is opt-in (`enable_deletes`, default off).

## B) LangMem conceptual guide

**Working URL:** `https://langchain-ai.github.io/langmem/concepts/conceptual_guide/` (200).
**Failed:** `https://langchain-ai.github.io/langmem/concepts/` → **404** (use `conceptual_guide/`).
Supporting pages: `/hot_path_quickstart/`, `/background_quickstart/`, `/reference/memory/`, `/guides/summarization/` (all 200).

### B1. Hot path vs background (verbatim terms)

- Hot path quickstart: "**In the hot path (this guide):** the agent consciously saves notes using tools."
- Background quickstart: "**In the background (this guide)**: memories are "subconsciously" extracted automatically from conversations."
- Conceptual guide table: "| Active | Higher | Immediate | During Response | Critical Context Updates |" and "| Background | None | Delayed | Between/After Calls | Pattern Analysis, Summaries |".
- "Conscious Formation": "You may want your agent to save memories "in the hot path". This active memory formation happens during the conversation, enabling immediate updates when critical context emerges."
- "Subconscious Formation": ""Subconscious" memory formation refers to the technique of prompting an LLM to reflect on a conversation after it occurs (or after it has been inactive for some period), finding patterns and extracting insights without slowing down the immediate interaction [...]"
- "Active formation happens during conversations [...] Background formation occurs between interactions, allowing deeper pattern analysis without impacting response time."

### B2. Memory types → API mapping

Table: Semantic = "Facts & Knowledge" (storage: "Profile or Collection"); Episodic = "Past Experiences" (storage: "Collection"); Procedural = "System Behavior" (storage: "Prompt rules or Collection").

- `create_memory_manager` — core extraction API: "Create a memory manager that processes conversation messages and generates structured memory entries." Used with `schemas=[UserProfile]` (semantic profile), default `Memory` (semantic collection), and `schemas=[Episode]` (episodic); `enable_inserts/updates/deletes` control reconcile.
- `create_prompt_optimizer` — procedural: "Update prompt rules and core behavior based on conversation information (with optional feedback)"; used in the "Procedural Memory: System Instructions" section.
- `create_memory_store_manager` — persistence layer: "Enriches memories stored in the configured BaseStore" and "Automatically persist extracted memories" into "LangGraph's long-term memory store".
- **Flag:** the docs do not state a strict one-to-one type→function mapping for `create_memory_store_manager`; it wraps the memory manager and persists to the store (schemas decide the type). Mapping above is the documented usage pattern, not an explicit claim.

### B3. Tradeoffs of hot-path formation

- "However, it adds perceptible latency to user interactions, and it adds one more obstacle to the agent's ability to satisfy the user's needs."
- Table row: Active → Latency Impact "Higher", Update Speed "Immediate", Processing Load "During Response".
- Background table row: Latency Impact "None", Update Speed "Delayed".
- **Flag:** no verbatim "wrong-time writes" statement found. Nearest documented concerns: hot-path "impact agent latency" + extra tool decision, and for background "Deciding when to trigger memory formation is also important" (LangGraph concepts/memory "In the background").

## C) Zep / Graphiti

**Working URLs:** `https://github.com/getzep/graphiti` (README), `https://help.getzep.com/graphiti/getting-started/overview` (200), and Markdown variants `https://help.getzep.com/<page>.md` (all 200: `/graphiti/core-concepts/adding-episodes.md`, `/graphiti/core-concepts/communities.md`, `/graphiti/working-with-data/searching.md`, `/episodes.md`, `/facts.md`, `/searching-the-graph.md`, `/graph-overview.md`). Paper: `https://arxiv.org/abs/2501.13956` / HTML `https://arxiv.org/html/2501.13956v1`.
**Failed:** `https://docs.graphiti.dev` → **connection failure (000), no such site**; `help.getzep.com` HTML pages are JS-rendered, so the `.md` suffix is the working route.

### C1. Episodes, semantic edges, bi-temporal, invalidation, communities

- Episode (Zep docs, `/episodes.md`): "An **episode** is a raw data artifact a developer hands to Zep — a chat message, a freeform text chunk, or a JSON object." / "Zep stores each episode verbatim alongside the entities, edges, and summaries it derives from that data [...]"
- Episode (Graphiti docs, adding-episodes.md): "Episodes represent a single data ingestion event. An `episode` is itself a node, and any nodes identified while ingesting the episode are related to the episode via `MENTIONS` edges."
- Episodic edges (paper): "The episodic edges, ℰe, connect episodes to their extracted entity nodes."
- Semantic entity edges (paper): "Entity edges (semantic edges), ei ∈ ℰs ⊆ φ*(𝒩s × 𝒩s), represent relationships between entities extracted from episodes."
- Bi-temporal (paper): "the system tracks four timestamps: t′created and t′expired ∈ T′ monitor when facts are created or invalidated in the system, while tvalid and tinvalid ∈ T track the temporal range during which facts held true." (arXiv HTML renders math with markup; field names below are exact.)
- Zep docs `/facts.md`: "Each fact stored on an edge includes four different timestamp attributes": `created_at` "The time Zep learned that the user got married", `valid_at` "The time the user got married", `invalid_at` "The time the user got divorced", `expired_at` "The time Zep learned that the user got divorced".
- Graphiti source (`graphiti_core/edges.py`, `EntityEdge`): fields `expired_at` = "datetime of when the node was invalidated", `valid_at` = "datetime of when the fact became true", `invalid_at` = "datetime of when the fact stopped being true".
- Invalidation not deletion (README): "**Temporal Fact Management:** Facts have validity windows. When information changes, old facts are invalidated — not deleted."
- Invalidation mechanism (paper): "it invalidates the affected edges by setting their tinvalid to the tvalid of the invalidating edge."
- Zep docs `/facts.md`: "Zep attempts to invalidate the fact that Kendra loves Adidas shoes and creates two new facts [...]"
- Communities (docs): "In Graphiti, communities (represented as `CommunityNode` objects) represent groups of related entity nodes."
- Communities (docs): "Communities contain a summary field that collates the summaries held on each of its member entities."
- Communities (paper): "Community nodes (communities), ni ∈ 𝒩c, represent clusters of strongly connected entities. Communities contain high-level summarizations of these clusters [...]"
- **Flag (source contradiction):** current Graphiti docs say "Communities are determined using the Leiden algorithm"; the Zep paper says "we employ a label propagation algorithm rather than the Leiden algorithm." Both are official Zep/Graphiti sources.

**Mechanics:** ingestion creates an episode node holding raw input; extraction produces entity nodes and fact edges, linked back to the episode by episodic (`MENTIONS`-style) edges. Each fact edge carries two timelines — real-world validity (`valid_at`/`invalid_at`) and system/transaction time (`created_at`/`expired_at`). New contradicting facts invalidate old edges by writing `invalid_at`, never deleting; history remains queryable. Communities are higher-tier nodes whose summaries are map-reduce collations of member entities, updated when new episodes arrive.

### C2. Zep / Graphiti retrieval path

- Zep docs `/searching-the-graph.md`: "Zep graph search combines semantic similarity with BM25 full-text search."
- "**Breadth-first search** (optional): Biases results toward information connected to specified starting nodes, useful for contextual relevance"
- "**Hybrid results**: Combines and reranks results using reciprocal rank fusion (RRF)"
- `reranker` parameter values: `"rrf"`, `"mmr"`, `"node_distance"`, `"episode_mentions"`, `"cross_encoder"` (default `"rrf"`); BFS seeded by `bfs_origin_node_uuids` ("Up to five node or episode UUIDs that seed breadth-first searches").
- Paper: "Zep implements three search functions: cosine semantic similarity search (φcos), Okapi BM25 full-text search (φbm25), and breadth-first search (φbfs)."
- Paper: "Zep supports existing reranking approaches such as Reciprocal Rank Fusion (RRF) and Maximal Marginal Relevance (MMR)."
- Paper: "The system's most sophisticated reranking capability employs cross-encoders—LLMs that generate relevance scores by evaluating nodes and edges against queries using cross-attention, though this approach incurs the highest computational cost."
- Graphiti docs searching.md: "Combines semantic similarity and BM25 retrieval, reranked using Reciprocal Rank Fusion." Cross encoders supported: "`OpenAIRerankerClient` (the default)", "`GeminiRerankerClient`", "`BGERerankerClient`".
- Graphiti docs: "`COMBINED_HYBRID_SEARCH_CROSS_ENCODER` | Performs a full-text search, similarity search, and BFS with cross_encoder reranking over edges, nodes, and communities."

**Mechanics:** candidate generation = embedding cosine similarity + Okapi BM25 full-text (+ optional BFS expansion from seed nodes/episodes); then a reranker reorders — RRF (default) or MMR (needs `mmr_lambda`), node-distance (needs `center_node_uuid`), episode-mentions (needs `search_filters.episode_uuids`), or cross-encoder (highest accuracy/cost). Results are assembled into a context block; `scope` selects edges / nodes / episodes / observations / thread_summaries / auto.

### C3. Raw episode = non-lossy, traceable store

- Paper: "Episodes serve as a non-lossy data store from which semantic entities and relations are extracted."
- Paper: "This design reinforces the non-lossy nature of Graphiti's episodic subgraph by enabling both forward and backward traversal: semantic artifacts can be traced to their sources for citation or quotation [...]"
- README table: "**Episodes** (provenance) | Raw data as ingested — the ground truth stream. Every derived fact traces back here"
- README: "**Episodes & Provenance:** Every entity and relationship traces back to the episodes (raw data) that produced it. Full lineage from derived fact to source."
- Zep docs `/episodes.md`: "Zep stores each episode verbatim alongside the entities, edges, and summaries it derives from that data, so the original source remains available even after extraction has finished."

## D) Letta

### D1. Archival memory

**Working URL:** `https://docs.letta.com/v1-sdk/memory/archival-memory.md` (200, as suggested). Companion: `https://docs.letta.com/v1-sdk/memory/context-hierarchy.md` (200). Note: these now sit under docs nav "V1 SDK (legacy)".

- "Archival memory is a semantically searchable database where agents can store facts, knowledge, and information for long-term retrieval."
- "Unlike memory blocks, archival memory fragments cannot be pinned to the context window, and must be queried on-demand via tools."
- Key characteristics: "**Agent-immutable** - Agents cannot easily modify or delete archival memories (though developers can via SDK)"; "**Unlimited storage** - No practical size limits"; "**Semantic search** - Find information by meaning, not exact keywords"; "**Tagged organization** - Agents can categorize memories with tags".
- Tool names (exact): "`archival_memory_insert` - Store new information" and "`archival_memory_search` - Query for relevant memories".
- Pagination: yes — `archival_memory_search(query=..., tags=["technical"], page=0)`; SDK `client.agents.passages.search(agent_id=..., query=..., tags=..., page=0)`.
- Context-hierarchy table: Archival Memory — Access "Read-write", In-Context "No", Tools "`archival_memory_insert` `archival_memory_search` & custom tools", Size Limit "300 tokens", Count Limit "Unlimited".

**Mechanics:** agent-invoked tool calls insert tagged text fragments and query them by semantic similarity with an optional tag filter and a `page` index (paginated results). Developers manipulate the same store via `client.agents.passages.*` (`insert`, `search`, `list`, `update`, `delete`).

### D2. Recall memory and the exact tier names

Current `docs.letta.com` has **no page titled "recall memory"** (docs were restructured; V1 SDK pages cover memory blocks + archival memory only). Confirmed statements:

- Exact tier names (official Letta blog `https://www.letta.com/blog/agent-memory`, headings verbatim): "Message Buffer: Recent Messages", "Core Memory: In-Context Memory Blocks", "Recall Memory: Conversational History", "Archival Memory: Explicitly Stored Knowledge".
- "Recall memory preserves the complete history of interactions that can be searched and retrieved when needed, even when not in the active context window (i.e., in the message buffer)."
- "In Letta, recall memory saves to disk automatically, while other frameworks require developers to handle persistence manually."
- Message buffer: "The message buffer stores the most recent messages in a conversation. In Letta, every agent maintains a single perpetual thread [...]"
- Core memory: "Core memory consists of in-context memory blocks that can be managed by the agent itself or by other agents."
- Archival memory: "Archival memory represents explicitly formulated knowledge stored in external databases. Unlike recall memory, which stores raw conversation history, archival memory contains processed and indexed information."
- `conversation_search` (docs `https://docs.letta.com/v1-sdk/messages/conversations/index.md`): "Messages from all conversations are pooled together in a searchable database. The agent can use `conversation_search` to recall context from any past conversation, not just the current one."
- "core memory" also in docs page title: `https://docs.letta.com/v1-sdk/memory/memory-blocks/index.md` — "Memory blocks (core memory)".
- "recall memory" in the official Letta Code harness system prompt (`https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md`): "All of your experience (message history) is stored in *recall memory* automatically by the Letta Code harness (cannot be mutated)"; "Your recall memory contains messages from your own past. It is NEVER injected [...]".
- "message buffer" in the REST API reference (`https://docs.letta.com/api/resources/agents/methods/create/index.md`): fields "`message_buffer_autoclear: optional boolean`", "`max_message_buffer_length`", "`min_message_buffer_length`"; "the agent will still retain state via core memory blocks and archival/recall memory".

**Flag:** "recall memory" is live Letta terminology but is currently documented on the Letta blog and in the harness prompt, not on a dedicated docs.letta.com concept page; the current docs page expresses the same tier as "Searchable message history" with the `conversation_search` tool.

### D3. Sleep-time agents / sleep-time compute

**URL status:** `https://docs.letta.com/guides/agents/sleep-time-agents` now **308-redirects to `https://docs.letta.com/configuration/memory`** ("Memory & dreaming"); the `.md` variant 404s; `https://docs.letta.com/guides/agents/architectures` also 308s to the same page. The concept survives on the Letta blog (200): `https://www.letta.com/blog/sleep-time-compute`. `https://www.letta.com/blog/agent-memory` also covers it. Internet Archive was offline (503) so no archived snapshot was retrieved.

- "Sleep-time compute is a new way to scale AI capabilities: letting models "think" during downtime."
- "Instead of sitting idle between tasks, AI agents can now use their "sleep" time to process information and form new connections by rewriting their memory state."
- "When you create agents with this type, Letta actually creates two agents under the hood: a primary agent and a sleep-time agent."
- "However the primary agent is not provided with tools to edit its core memory, which is the memory stored in-context composed of memory blocks. These tools are attached to the sleep-time agent, which has the ability to manage *both* the in-context memory of the primary agent as well as its own in-context memory."
- Offline vs online: "Reasoning during sleep time transforms "raw context" into "learned context", which can then be used later during test time."
- "Offloading memory to a sleep-time agent allows memory management to happen asynchronously."
- "**Proactive Memory Refinement:** Instead of lazy, incremental updates during conversations, memory can be reorganized and improved during idle periods."
- "Importantly, the sleep-time agent modifies the memory in an "anytime" fashion - so the primary agent can read from this memory whenever, without having to wait for the sleep-time agent to finish its reasoning."
- Current successor wording (docs `/configuration/memory.md`): "Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work."

**Mechanics:** a paired sleep-time agent runs between/behind user turns and is the only one holding memory-edit tools; it rewrites the primary agent's in-context memory blocks (its "core memory") asynchronously, so block content is pre-computed before the next user query and the primary agent never blocks on memory writes.

**Flag (block names):** the blog does **not** name specific block labels (e.g. `persona`/`human`/a shared `sleeptime` block). It states only that the sleep-time agent manages "the in-context memory of the primary agent as well as its own in-context memory". No verbatim confirmation of a shared, named sleep-time block was found in current Letta docs or the blog — treat any specific block label as unconfirmed.

## Unconfirmed / not found

- LangGraph docs do not use the exact phrase "long-term memory store" (LangMem does).
- LangMem does not explicitly state a one-to-one type→function mapping for `create_memory_store_manager`.
- LangMem/LangGraph contain no verbatim "wrong-time writes" statement for hot-path memory.
- Current Graphiti docs (Leiden) contradict the Zep paper (label propagation) on community detection.
- Letta has no current docs.letta.com page using the term "recall memory"; no sleep-time docs page survives at its old URL (redirects to "Memory & dreaming").
- No named shared sleep-time memory block was found.
- `https://docs.graphiti.dev` does not resolve.
