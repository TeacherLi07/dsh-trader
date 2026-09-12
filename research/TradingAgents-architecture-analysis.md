# TradingAgents (TauricResearch) — Architectural Analysis

Source: `/tmp/TradingAgents`, commit `be952b8` ("Merge pull request #1310 from TauricResearch/v0.4.2"). `pyproject.toml:7` declares `version = "0.4.0"`; CHANGELOG top entry `[0.4.0] — 2026-08-31`. Read-only analysis; no repo files modified. All citations are `file:line`.

> **This is not the classic 2025 TradingAgents release.** It has structured outputs, FRED + Polymarket vendors, a markdown memory log, SQLite checkpointing, crypto mode, and a different memory model. `reflect_and_remember` and the ChromaDB `FinancialSituationMemory` are gone — `tests/test_memory_log.py:856-858` asserts `not hasattr(TradingAgentsGraph, "reflect_and_remember")`, and `main.py:19` still references it, commented out.

---

## 0. Three headline findings that reframe everything else

1. **There is no execution layer at all.** No broker/exchange client, no order placement, no portfolio accounting, no backtester — verified by exhaustive grep. `backtrader` (`pyproject.toml:13`) and `redis` (`pyproject.toml:25`) are declared hard dependencies that are **never imported**.
2. **The CLI never runs the memory/reflection subsystem.** The CLI streams `graph.graph.stream(...)` directly (`cli/main.py:1144`) and never calls `propagate()`. Verified: `grep -n "propagate\|_run_graph\|process_signal\|store_decision\|past_context\|_resolve_pending" cli/main.py cli/utils.py` returns exactly one hit — a comment at `cli/main.py:1116`. Consequences on the primary user-facing entry point: no memory-log write, no pending-outcome resolution, no reflection, no `past_context` injection, no `full_states_log_*.json`, and no Buy/Hold/Sell extraction.
3. **The `NO_DATA_AVAILABLE` router and the look-ahead guards are the most valuable engineering in the repo** — genuinely production-grade relative to comparable OSS agent stacks — while everything downstream of the final decision is absent.

---

## 1. Graph topology

### 1.1 Nodes (20 with the default four analysts)

Created at `tradingagents/graph/setup.py:98-111`; analyst nodes come from a plan so their names follow the selection (`tradingagents/graph/analyst_execution.py:20-53`).

| Node | Kind |
|---|---|
| `Market Analyst` / `tools_market` / `Msg Clear Market` | agent / `ToolNode` / message-wipe |
| `Sentiment Analyst` / `tools_social` / `Msg Clear Sentiment` | (wire key stays `social` for saved-config back-compat, `analyst_execution.py:28-38`) |
| `News Analyst` / `tools_news` / `Msg Clear News` | |
| `Fundamentals Analyst` / `tools_fundamentals` / `Msg Clear Fundamentals` | |
| `Bull Researcher`, `Bear Researcher` | agents (quick LLM) |
| `Research Manager` | agent (deep LLM) |
| `Trader` | agent (quick LLM) |
| `Aggressive Analyst`, `Conservative Analyst`, `Neutral Analyst` | agents (quick LLM) |
| `Portfolio Manager` | agent (deep LLM) |

### 1.2 Edge construction (verbatim)

```python
# setup.py:113-135
        # Start with the first analyst
        workflow.add_edge(START, plan.specs[0].agent_node)

        # Connect analysts in sequence
        for i, spec in enumerate(plan.specs):
            ...
            workflow.add_conditional_edges(
                current_analyst,
                getattr(self.conditional_logic, f"should_continue_{spec.key}"),
                [current_tools, current_clear],
            )
            workflow.add_edge(current_tools, current_analyst)

            # Connect to next analyst or to Bull Researcher if this is the last analyst
            if i < len(plan.specs) - 1:
                workflow.add_edge(current_clear, plan.specs[i + 1].agent_node)
            else:
                workflow.add_edge(current_clear, "Bull Researcher")
```

```python
# setup.py:137-154
        for debate_node in ("Bull Researcher", "Bear Researcher"):
            workflow.add_conditional_edges(
                debate_node,
                self.conditional_logic.should_continue_debate,
                DEBATE_PATH_MAP,
            )
        workflow.add_edge("Research Manager", "Trader")
        workflow.add_edge("Trader", "Aggressive Analyst")
        for risk_node in ("Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"):
            workflow.add_conditional_edges(
                risk_node,
                self.conditional_logic.should_continue_risk_analysis,
                RISK_ANALYSIS_PATH_MAP,
            )

        workflow.add_edge("Portfolio Manager", END)
```

Path maps (`setup.py:32-42`) are complete supersets of each router's return set so a fall-through can never hit a missing key (guards issue #1088):

```python
DEBATE_PATH_MAP = {
    "Bull Researcher": "Bull Researcher",
    "Bear Researcher": "Bear Researcher",
    "Research Manager": "Research Manager",
}
RISK_ANALYSIS_PATH_MAP = {
    "Aggressive Analyst": "Aggressive Analyst",
    "Conservative Analyst": "Conservative Analyst",
    "Neutral Analyst": "Neutral Analyst",
    "Portfolio Manager": "Portfolio Manager",
}
```

### 1.3 Every conditional edge and its predicate

| Edge | Predicate | Returns |
|---|---|---|
| `Market Analyst →` | `should_continue_market` (`conditional_logic.py:14-20`) | `tools_market` if `messages[-1].tool_calls` else `Msg Clear Market` |
| `Sentiment Analyst →` | `should_continue_social` (`:22-34`) | `tools_social` / `Msg Clear Sentiment` |
| `News Analyst →` | `should_continue_news` (`:36-42`) | `tools_news` / `Msg Clear News` |
| `Fundamentals Analyst →` | `should_continue_fundamentals` (`:44-50`) | `tools_fundamentals` / `Msg Clear Fundamentals` |
| `Bull Researcher →`, `Bear Researcher →` | `should_continue_debate` (`:52-61`) | see below |
| `Aggressive`/`Conservative`/`Neutral Analyst →` | `should_continue_risk_analysis` (`:63-73`) | see below |

```python
# conditional_logic.py:52-73
    def should_continue_debate(self, state: AgentState) -> str:
        """Determine if debate should continue."""

        if (
            state["investment_debate_state"]["count"] >= 2 * self.max_debate_rounds
        ):  # 3 rounds of back-and-forth between 2 agents
            return "Research Manager"
        if state["investment_debate_state"]["current_response"].startswith("Bull"):
            return "Bear Researcher"
        return "Bull Researcher"

    def should_continue_risk_analysis(self, state: AgentState) -> str:
        """Determine if risk analysis should continue."""
        if (
            state["risk_debate_state"]["count"] >= 3 * self.max_risk_discuss_rounds
        ):  # 3 rounds of back-and-forth between 3 agents
            return "Portfolio Manager"
        if state["risk_debate_state"]["latest_speaker"].startswith("Aggressive"):
            return "Conservative Analyst"
        if state["risk_debate_state"]["latest_speaker"].startswith("Conservative"):
            return "Neutral Analyst"
        return "Aggressive Analyst"
```

Structural notes: both debate edges share **one** stateless router, and all three risk edges share **one** router. The router re-derives "who spoke last" from state, which is why `current_response` / `latest_speaker` exist and why routing is coupled to the literal speech prefix (`f"Bull Analyst: {response.content}"`, `bull_researcher.py:52`). The risk router's fall-through (`return "Aggressive Analyst"`) does double duty: it is both the intended "Neutral just spoke → loop back" edge **and** the drift guard. `count` increments unconditionally so it always terminates.

### 1.4 Exact execution order (defaults: `market, social, news, fundamentals`; 1 debate round; 1 risk round)

```
START
  → Market Analyst        ↺ tools_market → Market Analyst
  → Msg Clear Market
  → Sentiment Analyst     ↺ tools_social → Sentiment Analyst
  → Msg Clear Sentiment
  → News Analyst          ↺ tools_news → News Analyst
  → Msg Clear News
  → Fundamentals Analyst  ↺ tools_fundamentals → Fundamentals Analyst
  → Msg Clear Fundamentals
  → Bull Researcher        (count 1)
  → Bear Researcher        (count 2)
  → Research Manager       (2 >= 2*1 → terminate)
  → Trader
  → Aggressive Analyst     (count 1, latest_speaker="Aggressive")
  → Conservative Analyst   (count 2, latest_speaker="Conservative")
  → Neutral Analyst        (count 3, latest_speaker="Neutral")
  → Portfolio Manager      (3 >= 3*1 → terminate)
  → END
```

Speech budget: `2 * max_debate_rounds` bull/bear speeches, `3 * max_risk_discuss_rounds` risk speeches. The loops are **`>=`-terminated, not `>`**, and the router runs *after* the node — so with the knob at 0 the first speaker still speaks once. There is no way to configure zero debate. Because the debate cap is an even multiple, **the bull/bear debate always ends on a Bear speech** — Bull never gets the last word.

### 1.5 ASCII diagram

```
                                  ┌─────────┐
                                  │  START  │
                                  └────┬────┘
                                       │ setup.py:115
                                       ▼
                        ┌──────────────────────────────┐
        ┌──────────────▶│  Market Analyst              │
        │               └──────────────┬───────────────┘
        │                              │ should_continue_market
        │        tool_calls? ┌─────────┴─────────┐
        │        yes         │                   │ no
        │        ▼           │                   ▼
        │  ┌──────────────┐  │         ┌──────────────────┐
        └──│ tools_market │  │         │ Msg Clear Market │
           └──────────────┘  │         └────────┬─────────┘
                             ▼                  │
              ┌──────────────────────────────┐  │  (same pattern repeats for
              │  Sentiment Analyst  ⇄ tools_social        │   social → news →
              │  News Analyst       ⇄ tools_news          │   fundamentals)
              │  Fundamentals Analyst ⇄ tools_fundamentals│
              └──────────────┬───────────────┘
                             ▼ Msg Clear Fundamentals
              ┌──────────────────────────────┐
              │      Bull Researcher         │◀──────────────┐
              └──────────────┬───────────────┘               │
                             │ should_continue_debate        │
                  count<2N   │                    last!="Bull"│
                             ▼                               │
              ┌──────────────────────────────┐               │
              │      Bear Researcher         │───────────────┘
              └──────────────┬───────────────┘
                             │ count >= 2N
                             ▼
              ┌──────────────────────────────┐
              │      Research Manager        │  deep LLM · structured ResearchPlan
              └──────────────┬───────────────┘
                             ▼
              ┌──────────────────────────────┐
              │           Trader             │  quick LLM · structured TraderProposal
              └──────────────┬───────────────┘
                             ▼
              ┌──────────────────────────────┐
              │     Aggressive Analyst       │◀─────────────┐
              └──────────────┬───────────────┘              │
                             │ latest=="Aggressive"         │
                             ▼                              │
              ┌──────────────────────────────┐              │
              │    Conservative Analyst      │              │
              └──────────────┬───────────────┘              │
                             │ latest=="Conservative"       │
                             ▼                              │
              ┌──────────────────────────────┐              │
              │       Neutral Analyst        │              │
              └──────────────┬───────────────┘              │
                             │ else (last=="Neutral" / drift)┘
                             │ count >= 3M
                             ▼
              ┌──────────────────────────────┐
              │      Portfolio Manager       │  deep LLM · structured PortfolioDecision
              └──────────────┬───────────────┘
                             ▼
                        ┌─────────┐
                        │   END   │
                        └─────────┘
   N = max_debate_rounds (default 1)      M = max_risk_discuss_rounds (default 1)
   ⇄ = agent/tool inner loop, wiped by the Msg Clear node that follows
```

Invocation (`propagation.py:71-84`): `{"stream_mode": "values", "config": {"recursion_limit": 100}}` — `max_recur_limit: 100` (`default_config.py:118`) is a hard super-step ceiling with no step-budget guard and no graceful degradation.

---

## 2. State schema

`tradingagents/agents/utils/agent_states.py` is the entire schema (76 lines).

```python
# agent_states.py:8-18
class InvestDebateState(TypedDict):
    bull_history: Annotated[str, "Bullish Conversation history"]
    bear_history: Annotated[str, "Bearish Conversation history"]
    history: Annotated[str, "Conversation history"]
    current_response: Annotated[str, "Latest response"]
    judge_decision: Annotated[str, "Final judge decision"]
    count: Annotated[int, "Length of the current conversation"]
```

```python
# agent_states.py:22-44
class RiskDebateState(TypedDict):
    aggressive_history: ...      conservative_history: ...      neutral_history: ...
    history: Annotated[str, "Conversation history"]
    latest_speaker: Annotated[str, "Analyst that spoke last"]
    current_aggressive_response: ...  current_conservative_response: ...
    current_neutral_response: ...
    judge_decision: Annotated[str, "Judge's decision"]
    count: Annotated[int, "Length of the current conversation"]
```

```python
# agent_states.py:47-76
class AgentState(MessagesState):
    company_of_interest: Annotated[str, "Company that we are interested in trading"]
    asset_type: Annotated[str, "Asset type under analysis such as stock or crypto"]
    instrument_context: Annotated[str, "Deterministic ticker identity resolved at run start"]
    trade_date: Annotated[str, "What date we are trading at"]

    sender: Annotated[str, "Agent that sent this message"]

    # research step
    market_report: Annotated[str, "Report from the Market Analyst"]
    sentiment_report: Annotated[str, "Report from the Sentiment Analyst"]
    news_report: Annotated[str, "Report from the News Researcher of current world affairs"]
    fundamentals_report: Annotated[str, "Report from the Fundamentals Researcher"]

    # researcher team discussion step
    investment_debate_state: Annotated[InvestDebateState, "Current state of the debate on if to invest or not"]
    investment_plan: Annotated[str, "Plan generated by the Analyst"]

    trader_investment_plan: Annotated[str, "Plan generated by the Trader"]

    # risk management team discussion step
    risk_debate_state: Annotated[RiskDebateState, "Current state of the debate on evaluating risk"]
    final_trade_decision: Annotated[str, "Final decision made by the Risk Analysts"]
    past_context: Annotated[str, "Memory log context injected at run start (same-ticker decisions + cross-ticker lessons)"]
```

**Reducers.** Only `messages` has one (inherited from `MessagesState`, i.e. `add_messages` — append/dedupe with `RemoveMessage` support). Every other key, including both debate sub-dicts, is **last-write-wins replace**. Consequence: every debate node must re-emit its *entire* sub-dict, and any key it omits is dropped — which is why the debators contain long repetitive dict literals (`bull_researcher.py:54-60`, `aggressive_debator.py:48-60`). In particular, `Aggressive`/`Conservative`/`Neutral` do **not** carry `judge_decision` forward, so between the Trader and the Portfolio Manager the risk sub-dict genuinely lacks that key; consumers use `.get()` (`cli/main.py:1211`) or read the final state where the PM has set it.

### 2.1 Which node writes which key

Initialized by `Propagator.create_initial_state` (`propagation.py:18-69`): `messages=[("human", company_name)]`, `company_of_interest`, `asset_type`, `instrument_context`, `trade_date`, `past_context`, four empty report strings, and both debate dicts fully zeroed (`count: 0`).

| Key | Written by |
|---|---|
| `messages` | 4 analysts (`{"messages": [result], "<x>_report": report}`), each `ToolNode`, `Msg Clear <X>` (`agent_utils.py:204-228`), `Trader` (`trader.py:85`) |
| `company_of_interest`, `asset_type`, `instrument_context`, `trade_date`, `past_context` | initial state only — never rewritten |
| `market_report` | `Market Analyst` (`market_analyst.py:92`) |
| `sentiment_report` | `Sentiment Analyst` (`sentiment_analyst.py:124`) |
| `news_report` | `News Analyst` (`news_analyst.py:66`) |
| `fundamentals_report` | `Fundamentals Analyst` (`fundamentals_analyst.py:66`) |
| `investment_debate_state.{history,bull_history,current_response,count}` | `Bull Researcher` (`bull_researcher.py:54-60`) |
| `investment_debate_state.{history,bear_history,current_response,count}` | `Bear Researcher` (`bear_researcher.py:56-62`) |
| `investment_debate_state.judge_decision` + all 6 keys re-emitted | `Research Manager` (`research_manager.py:56-63`) |
| `investment_plan` | `Research Manager` (`research_manager.py:67`) |
| `trader_investment_plan`, `sender` | `Trader` (`trader.py:86-87`) — `sender` is written **only** here and read nowhere in the package |
| `risk_debate_state.{history,*_history,latest_speaker,current_*_response,count}` | the three risk debators (`aggressive_debator.py:48-60`, `conservative_debator.py:48-62`, `neutral_debator.py:48-60`) |
| `risk_debate_state.judge_decision` + all 10 keys, `latest_speaker="Judge"` | `Portfolio Manager` (`portfolio_manager.py:77-88`) |
| `final_trade_decision` | `Portfolio Manager` (`portfolio_manager.py:92`) |

### 2.2 How message histories are carried and capped

Messages are **not** carried across the pipeline. After every analyst, `Msg Clear <X>` deletes *all* messages and inserts one anchored placeholder:

```python
# agent_utils.py:204-228
def create_msg_delete():
    def delete_messages(state):
        messages = state["messages"]
        removal_operations = [RemoveMessage(id=m.id) for m in messages]

        instrument_context = get_instrument_context_from_state(state)
        trade_date = state.get("trade_date", "the requested date")
        placeholder = HumanMessage(
            content=(
                f"Proceed with your assigned analysis for this workflow. "
                f"{instrument_context} The analysis date is {trade_date}."
            )
        )
        return {"messages": removal_operations + [placeholder]}
```

Shape by stage:
- **Analyst tool loop**: `[placeholder] + [AIMessage(tool_calls), ToolMessage(s)] * k + [AIMessage(final)]` — grows within one analyst, then wiped.
- **After `Msg Clear Fundamentals`**: `messages == [placeholder]` only.
- **Debate + risk phases**: bull/bear/risk/RM/PM append **nothing**; they communicate exclusively through the two debate sub-dicts and the plan strings.
- **Trader**: appends one `AIMessage` (`trader.py:85`) — the only post-analyst message writer.

There is **no token-budget truncation, no summarization, no sliding window**. Bounded-growth mechanisms that exist are content-level: `news_article_limit: 20`, `global_news_article_limit: 10`, `global_news_lookback_days: 7` (`default_config.py:122-124`), `MAX_ROWS = 40` for FRED (`fred.py:40`), StockTwits `limit=30` (`sentiment_analyst.py:74`), `max_recur_limit: 100`, and `memory_log_max_entries` (default `None`).

The real unbounded-growth vector is the **debate transcripts**: `history + "\n" + argument` accumulates with no cap (`bull_researcher.py:55`, `bear_researcher.py:57`, `aggressive_debator.py:49`, `conservative_debator.py:49`, `neutral_debator.py:49`), and the full text is re-injected into every subsequent debator prompt *and* into the Research Manager / Portfolio Manager prompt in full.

---

## 3. Agent roles

### 3.1 LLM tier assignment

Analysts, Bull/Bear, Trader and the three risk debators use `quick_thinking_llm`; the Research Manager and Portfolio Manager use `deep_thinking_llm` (`setup.py:76-92`).

### 3.2 Analysts

All four share one prompt skeleton: routing preamble with `{tool_names}`, `{current_date}`, `{instrument_context}` → role message → `MessagesPlaceholder("messages")`.

```python
# market_analyst.py:60-70  (news/fundamentals identical modulo the role text)
                    "system",
                    "You are a helpful AI assistant, collaborating with other assistants."
                    " Use the provided tools to progress towards answering the question."
                    " If you are unable to fully answer, that's OK; another assistant with different tools"
                    " will help where you left off. Execute what you can to make progress."
                    " If you or any other assistant has the FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL** or deliverable,"
                    " prefix your response with FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL** so the team knows to stop."
                    " You have access to the following tools: {tool_names}."
                    " Today's date is {current_date}; treat it as 'now' for all analysis and tool-call date ranges. {instrument_context}\n"
                    "{system_message}",
```

**Market Analyst** (`analysts/market_analyst.py`)
- Inputs: `trade_date`, `instrument_context`/`company_of_interest`, `messages`.
- Tools (`trading_graph.py:213-224`): `get_stock_data`, `get_indicators`, `get_verified_market_snapshot`.
- Output: `{messages, market_report}`; `report` set **only** when `len(result.tool_calls) == 0` (`:87-88`).
- Structured output: **no** (`llm.bind_tools(tools)`, free text).
- Prompt highlights: a 12-indicator catalog (Moving Averages / MACD / Momentum / Volatility / Volume), "choose up to **8 indicators**", "do not select both rsi and stochrsi", "call `get_stock_data` first", plus a hard anti-hallucination clause:

```
# market_analyst.py:51-54
Before writing the final report, call get_verified_market_snapshot for this ticker and the current date, and treat it as the source of truth for any exact OHLCV, price-level, or indicator-value claim. If another tool's output conflicts with the verified snapshot, flag the discrepancy rather than inventing a reconciled number. Do not claim historical validation, support/resistance bounces, or exact percentage moves unless they are directly supported by tool output with concrete dates and prices.
```
  and "Make sure to append a Markdown table at the end of the report."

**Sentiment Analyst** (wire key `social`) (`analysts/sentiment_analyst.py`)
- Inputs: `company_of_interest`, `trade_date`, `messages`. Window = `trade_date - 7d` → `trade_date` (`:47-48`).
- Tools: **none** — data is pre-fetched into the prompt: `get_news.func(...)` (Yahoo), `fetch_stocktwits_messages(ticker, limit=30, start_date, end_date)`, `fetch_reddit_posts(ticker, start_date, end_date)` (`:70-76`). A `tools_social` ToolNode is still registered (`trading_graph.py:225-230`) but the prompt forbids tool calls via `NO_EXTERNAL_TOOLS`.
- Output: `{messages: [AIMessage], sentiment_report}`.
- **Structured output: yes** — `SentimentReport` (`overall_band: SentimentBand` 6-tier, `overall_score: float` `ge=0, le=10`, `confidence: Literal["low","medium","high"]`, `narrative`), rendered by `render_sentiment_report` (`schemas.py:285-368`).
- Prompt highlights: three delimited blocks (`<start_of_news>`, `<start_of_stocktwits>`, `<start_of_reddit>`), 8 numbered best-practices (StockTwits bullish/bearish ratio as leading signal; cross-source divergence; engagement weighting; opinion vs event; narrative themes; honest data limits; catalysts; "past sentiment is not predictive"), then an "## Output fields" section mirroring the Pydantic descriptions.
- Rationale in the module docstring: the old agent "had a prompt that demanded social-media analysis but the only tool available was Yahoo Finance news — which led LLMs to fabricate Reddit/X/StockTwits content under prompt pressure (verified live)" (`:3-6`).

**News Analyst** (`analysts/news_analyst.py`)
- Inputs: `trade_date`, `asset_type`, `instrument_context`, `messages`.
- Tools (`trading_graph.py:231-240`): `get_news`, `get_global_news`, `get_insider_transactions`, `get_macro_indicators`, `get_prediction_markets`.
- Output: `{messages, news_report}`. Structured: no.
- Prompt highlights: `asset_type`-aware nouns (`company` vs `asset`, `:16-17`) and explicit tool contracts naming FRED aliases (`'cpi', 'core_pce', 'unemployment', 'fed_funds_rate', '10y_treasury', 'yield_curve'`) and Polymarket topics.

**Fundamentals Analyst** (`analysts/fundamentals_analyst.py`)
- Inputs: `trade_date`, `instrument_context`, `messages`.
- Tools (`trading_graph.py:241-249`): `get_fundamentals`, `get_balance_sheet`, `get_cashflow`, `get_income_statement`.
- Output: `{messages, fundamentals_report}`. Structured: no.
- Prompt highlights: "analyzing fundamental information over the past week", "as much detail as possible", markdown table, per-tool usage map.
- **Unavailable in crypto mode** — `filter_analysts_for_asset_type` drops it (`cli/utils.py:90-99`).

### 3.3 Researchers (bull / bear)

`researchers/bull_researcher.py`, `bear_researcher.py` — symmetric.
- Inputs: `investment_debate_state` (`history`, `current_response`, own history), the four analyst reports, `instrument_context`, `asset_type`.
- Tools: **none**; single plain `llm.invoke(prompt)` (`bull_researcher.py:50`).
- Output: `{"investment_debate_state": {...}}` — no `messages`, no structured output.
- Prompt highlights: "You are a Bull Analyst advocating for investing in the {target_label}", five bullets (Growth Potential / Competitive Advantages / Positive Indicators / Bear Counterpoints / Engagement), a "Resources available" block interpolating all four reports + full debate history + opponent's last argument, and a conversational-style instruction. `asset_type` swaps the label and softens the fundamentals line to "may be unavailable for crypto" (`:22-28`).
- Opening-turn handling — the first speaker gets a synthetic marker instead of an empty opponent string:

```python
# agent_utils.py:68-79
def opponent_argument_or_opening(text: str, opponent: str) -> str:
    """Opponent's latest argument, or an explicit opening marker when empty.

    The first speaker in each debate round receives an empty opponent response;
    interpolating it into a "refute the opponent" prompt makes the model
    fabricate the other side's position. Returning a clear "has not spoken yet"
    marker instead lets it open with its own case (#1176).
    """
    text = (text or "").strip()
    if text:
        return text
    return f"(The {opponent} has not spoken yet — open the debate with your own case.)"
```
- Speech labelling drives routing: `f"Bull Analyst: {response.content}"` / `f"Bear Analyst: …"` (`bull_researcher.py:52`, `bear_researcher.py:54`) stored as `current_response`; the router branches on `.startswith("Bull")`.

### 3.4 Research Manager (`managers/research_manager.py`) — deep LLM, **structured**

- Inputs: `instrument_context`, `investment_debate_state.history`.
- Output: `{"investment_debate_state": {judge_decision, history, bear_history, bull_history, current_response, count}, "investment_plan": str}`; `judge_decision` and `investment_plan` are the same rendered markdown.
- Schema `ResearchPlan` (`schemas.py:87-118`): `recommendation: PortfolioRating`, `rationale`, `strategic_actions` ("including position sizing guidance consistent with the rating"). Rendered to `**Recommendation** / **Rationale** / **Strategic Actions**`.
- Prompt: "As the Research Manager and debate facilitator…", 5-tier scale with one-line definitions, an explicit anti-forced-direction clause, `**Debate History:** {history}`, `NO_EXTERNAL_TOOLS`.
- It also overwrites `current_response` with the plan (`:61`) — harmless, the debate router has already terminated.

### 3.5 Trader (`trader/trader.py`) — quick LLM, **structured**, `functools.partial(trader_node, name="Trader")`

- Inputs: `company_of_interest`, `instrument_context`, `investment_plan`, `market_report` (optional).
- Tools: none. Output: `{messages: [AIMessage], trader_investment_plan, sender: "Trader"}`.
- Schema `TraderProposal` (`schemas.py:137-179`): `action: TraderAction` (Buy/Hold/Sell only — deliberately 3-tier, `:68-79`), `reasoning`, `entry_price: float|None`, `stop_loss: float|None`, `position_sizing: str|None` ("e.g. '5% of portfolio'"). Rendered with back-compat trailer `FINAL TRANSACTION PROPOSAL: **{ACTION}**` (`:196-203`).
- Prompt: grounding is **conditional** on a non-empty market report (`:33-44`, #1167); explicit numeric-price rule — "State entry price and stop-loss as absolute price levels … never a percentage or a range" (#1288). A `field_validator` deletes a percentage where a price was requested (`schemas.py:33-50`).
- **`position_sizing` and `stop_loss` are free advisory text — nothing consumes them programmatically.**

### 3.6 Risk debators (`risk_mgmt/*.py`) — quick LLM, plain `llm.invoke`

- Inputs: `risk_debate_state` (history + the two opponents' `current_*_response`), four analyst reports, `instrument_context`, `trader_investment_plan`.
- Tools: none. Output: `{"risk_debate_state": {...}}`, with `latest_speaker` set to `"Aggressive"`/`"Conservative"`/`"Neutral"` — that literal string is the router's input.
- Prompt highlights: each frames a persona and requires engaging the other two by name, injecting all four reports plus the trader decision plus the full risk history; all three close with "Output conversationally as if you are speaking without any special formatting." The Aggressive one is explicitly a **defender of the trader's plan** ("create a compelling case for the trader's decision") rather than an independent third opinion — a structural bias worth noting.
- Comment/code drift: `conditional_logic.py:56,66` still say "3 rounds of back-and-forth" while the arithmetic is `2 *` and `3 *`.

### 3.7 Portfolio Manager (`managers/portfolio_manager.py`) — deep LLM, **structured**

- Inputs: `instrument_context`, `risk_debate_state.history`, `investment_plan`, `trader_investment_plan`, `past_context` (**the only node that reads `past_context`**).
- Output: `{"risk_debate_state": {...all 10 keys, latest_speaker="Judge"}, "final_trade_decision": str}`.
- Schema `PortfolioDecision` (`schemas.py:212-255`): `rating: PortfolioRating`, `executive_summary`, `investment_thesis`, `price_target: float|None`, `time_horizon: str|None`. Renderer at `:258-277`.
- Prompt includes the memory injection:

```python
# portfolio_manager.py:36-41
        past_context = state.get("past_context", "")
        lessons_line = (
            f"- Lessons from prior decisions and outcomes:\n{past_context}\n"
            if past_context
            else ""
        )
```

### 3.8 Structured-output plumbing

```python
# structured.py:42-56
def bind_structured(llm: Any, schema: type[T], agent_name: str) -> Any | None:
    try:
        return llm.with_structured_output(schema)
    except (NotImplementedError, AttributeError) as exc:
        logger.warning(
            "%s: provider does not support with_structured_output (%s); "
            "falling back to free-text generation",
            agent_name, exc,
        )
        return None
```

`invoke_structured_or_freetext` (`:59-89`) catches **any** exception (including `result is None`, `:76-80`) and retries once as plain free text — so "structured output" is best-effort, not enforced. The 5-tier rating is then recovered by **regex**, not by the schema:

```python
# rating.py:37-42
_RATING_LABEL_RE = re.compile(r"rating.*?[:\-][\s*]*(\w+)", re.IGNORECASE)
_RATING_WORD_RE = re.compile(
    r"\b(" + "|".join(RATINGS_5_TIER) + r")\b", re.IGNORECASE
)
```

`SignalProcessor.process_signal` returns the `REVIEW` sentinel when nothing matches (`signal_processing.py:29-38`) rather than fabricating a `Hold` (#1170) — but the memory log still uses the silent-default `parse_rating` (`memory.py:45`).

---

## 4. The debate loops

### 4.1 Bull/bear research debate

- Bound: `max_debate_rounds` (`default_config.py:116`, default `1`), wired at `trading_graph.py:137-140`.
- Count field: `investment_debate_state["count"]`, incremented by exactly 1 per speaker (`bull_researcher.py:59`, `bear_researcher.py:61`).
- Termination: `count >= 2 * max_debate_rounds` → `"Research Manager"` (`conditional_logic.py:55-58`).
- Alternation: from `current_response.startswith("Bull")` — content-driven, not a turn counter.
- Judge consumption: the Research Manager reads **only** `investment_debate_state["history"]` (`research_manager.py:22`) — every prefixed speech concatenated in order. It never sees `bull_history`/`bear_history` separately and has no score token; it must weigh prose.
- Ending: the RM writes the rendered plan into both `judge_decision` and `current_response`, then `Research Manager → Trader` is unconditional.

Bound accounting for `N = max_debate_rounds`:

| `count` after speech | Speaker | Router |
|---|---|---|
| 1 | Bull | `1 >= 2N`? N=0 → RM; else → Bear |
| 2 | Bear | `2 >= 2N`? N=1 → RM; else → Bull |
| … | … | … |
| `2N` | Bear | → RM |

### 4.2 Risk-management debate

- Bound: `max_risk_discuss_rounds` (`default_config.py:117`, default `1`).
- Count field: `risk_debate_state["count"]` (`aggressive_debator.py:59`, `conservative_debator.py:61`, `neutral_debator.py:59`).
- Termination: `count >= 3 * max_risk_discuss_rounds` → `"Portfolio Manager"` (`conditional_logic.py:65-68`).
- Rotation: `latest_speaker` string matching in fixed order Aggressive → Conservative → Neutral → Aggressive.
- Entry is unconditional: `workflow.add_edge("Trader", "Aggressive Analyst")` (`setup.py:145`) — the Aggressive analyst always speaks first and is prompted to *defend* the trader's proposal.
- Judge consumption: the PM reads `risk_debate_state["history"]` plus `investment_plan` and `trader_investment_plan` (`portfolio_manager.py:31-34`).

Both loops are **fixed-length scripts, not convergence tests**: no early exit on agreement, no per-speaker confidence, no "analysts converged" condition — only the arithmetic cap.

---

## 5. Memory and reflection

Three separate persistence mechanisms — do not conflate them.

| Artifact | Writer | Path | Reached from |
|---|---|---|---|
| Full run state JSON | `_log_state` (`trading_graph.py:576-616`) | `<results_dir>/<TICKER>/TradingAgentsStrategy_logs/full_states_log_<date>.json` | **`propagate()` only** — never the CLI |
| Decision + reflection log | `TradingMemoryLog` (`agents/utils/memory.py`) | `~/.tradingagents/memory/trading_memory.md` (`default_config.py:76`) | **`propagate()` only** — never the CLI |
| Report tree | `reporting.write_report_tree` | CLI: `<results_dir>/<raw ticker>/<date>/reports/*.md` (`cli/main.py:1034-1037`); API: `<results_dir>/reports/<TICKER>_<timestamp>/` (`trading_graph.py:500-507`) | both |
| Checkpoint DB | LangGraph `SqliteSaver` | `<data_cache_dir>/checkpoints/<TICKER>.db` | both, when enabled |
| OHLCV cache | `load_ohlcv` | `<data_cache_dir>/<SYMBOL>-YFin-data-<start>-<end>.csv` | both |

### 5.1 The decision log (Phase A — write)

```python
# memory.py:30-49
    def store_decision(self, ticker, trade_date, final_trade_decision) -> None:
        """Append pending entry at end of propagate(). No LLM call."""
        if not self._log_path:
            return
        # Idempotency guard: fast raw-text scan instead of full parse
        if self._log_path.exists():
            raw = self._log_path.read_text(encoding="utf-8")
            for line in raw.splitlines():
                if line.startswith(f"[{trade_date} | {ticker} |") and line.endswith("| pending]"):
                    return
        rating = parse_rating(final_trade_decision)
        tag = f"[{trade_date} | {ticker} | {rating} | pending]"
        entry = f"{tag}\n\nDECISION:\n{final_trade_decision}{self._SEPARATOR}"
        with open(self._log_path, "a", encoding="utf-8") as f:
            f.write(entry)
```

On-disk format — append-only markdown, separator `"\n\n<!-- ENTRY_END -->\n\n"` (`memory.py:13`, "HTML comment: cannot appear in LLM prose output, safe as a hard delimiter"):

```
[2026-01-05 | NVDA | Buy | pending]

DECISION:
**Rating**: Buy

**Executive Summary**: ...
**Investment Thesis**: ...

<!-- ENTRY_END -->
```

Called from `trading_graph.py:565-569` — i.e. **inside `_run_graph`, which the CLI never invokes.** Two further quirks: the pending rating comes from `parse_rating`, which silently defaults to `"Hold"` (`rating.py:69-78`), so a `REVIEW` decision is logged as `Hold`; and the idempotency guard is scoped to `(trade_date, ticker)` only, so a re-run with a *changed* decision does not update the stored entry.

### 5.2 Phase B — resolve pending entries

```python
# trading_graph.py:420-423
        self.ticker = company_name

        # Resolve any pending memory-log entries for this ticker before the pipeline runs.
        self._resolve_pending_entries(company_name)
```

```python
# trading_graph.py:326-365
        pending = [e for e in self.memory_log.get_pending_entries() if e["ticker"] == ticker]
        if not pending:
            return

        benchmark = self._resolve_benchmark(ticker)
        updates = []
        for entry in pending:
            raw, alpha, days, resolution_date = self._fetch_returns(
                ticker, entry["date"], benchmark=benchmark,
            )
            if raw is None:
                continue  # price not available yet — try again next run
            reflection = self.reflector.reflect_on_final_decision(
                final_decision=entry.get("decision", ""),
                raw_return=raw,
                alpha_return=alpha,
                benchmark_name=benchmark,
            )
            updates.append({...})
        if updates:
            self.memory_log.batch_update_with_outcomes(updates)
```

### 5.3 Realized return and alpha vs benchmark

```python
# trading_graph.py:290-318
            start = datetime.strptime(trade_date, "%Y-%m-%d")
            end = start + timedelta(days=holding_days + 7)  # buffer for weekends/holidays
            end_str = end.strftime("%Y-%m-%d")
            stock = yf.Ticker(normalize_symbol(ticker)).history(start=trade_date, end=end_str)
            bench = yf.Ticker(benchmark).history(start=trade_date, end=end_str)

            if len(stock) <= holding_days or len(bench) <= holding_days:
                return None, None, None, None

            raw = float(
                (stock["Close"].iloc[holding_days] - stock["Close"].iloc[0])
                / stock["Close"].iloc[0]
            )
            bench_ret = float(
                (bench["Close"].iloc[holding_days] - bench["Close"].iloc[0])
                / bench["Close"].iloc[0]
            )
            alpha = raw - bench_ret
            resolution_date = stock.index[holding_days].strftime("%Y-%m-%d")
```

`holding_days = 5` (`trading_graph.py:274`). Concretely: returns are **bar-indexed** (row 0 → row 5), entry is the **close of the first bar on/after `trade_date`**, alpha is a naive arithmetic `raw - bench_ret`, and the window must be fully traded or the entry stays pending (#1169). Benchmark: explicit `benchmark_ticker` → longest-suffix `benchmark_map` match → `SPY` (`trading_graph.py:252-271`; map `default_config.py:158-169`). This path bypasses vendor routing and calls `yf.Ticker(...)` directly.

### 5.4 Reflection prompt

```python
# reflection.py:14-29
    def _get_log_reflection_prompt(self) -> str:
        """Concise prompt for reflect_on_final_decision (Phase B log entries).

        Produces 2-4 sentences of plain prose — compact enough to be re-injected
        into future agent prompts without bloating the context window.
        """
        return (
            "You are a trading analyst reviewing your own past decision now that the outcome is known.\n"
            "Write exactly 2-4 sentences of plain prose (no bullets, no headers, no markdown).\n\n"
            "Cover in order:\n"
            "1. Was the directional call correct? (cite the alpha figure)\n"
            "2. Which part of the investment thesis held or failed?\n"
            "3. One concrete lesson to apply to the next similar analysis.\n\n"
            "Be specific and terse. Your output will be stored verbatim in a decision log "
            "and re-read by future analysts, so every word must earn its place."
        )
```

Human turn: `Raw return: {raw_return:+.1%}\nAlpha vs {benchmark_name}: {alpha_return:+.1%}\n\nFinal Decision:\n{final_decision}` (`:50-54`). One quick-LLM call per entry.

### 5.5 Write-back and rotation

`batch_update_with_outcomes` (`memory.py:177-229`) reads the whole file, splits on the separator, rewrites the matching tag and appends the reflection, then:

```python
# memory.py:225-229
        new_blocks = self._apply_rotation(new_blocks)
        new_text = self._SEPARATOR.join(new_blocks)
        tmp_path = self._log_path.with_suffix(".tmp")
        tmp_path.write_text(new_text, encoding="utf-8")
        tmp_path.replace(self._log_path)
```

Resolved tag: `[<date> | <ticker> | <rating> | +x.x% | +y.y% | 5d | resolved:<yyyy-mm-dd>]` (`memory.py:233-246`); `resolution_date` is the point-in-time marker (#1251). Rotation drops only **resolved** blocks beyond `memory_log_max_entries`; pending blocks are always kept (`:248-283`).

### 5.6 How prior decisions reach prompts — and how they do not

```python
# trading_graph.py:514-518
        # Initialize state — inject memory log context for PM and the
        # deterministically resolved instrument identity for all agents. On a
        # historical run, gate lessons to those whose outcome was known by the
        # trade date so a backtest can't learn from the future (#1251).
        past_context = self.memory_log.get_past_context(
            company_name, as_of=self._memory_as_of(trade_date)
        )
```

```python
# trading_graph.py:379-388
    def _memory_as_of(self, trade_date) -> str | None:
        td = str(trade_date)
        return td if td < datetime.now().strftime("%Y-%m-%d") else None
```

Selection (`memory.py:70-107`): latest `n_same=5` same-ticker entries formatted **in full** (tag + `DECISION:` + `REFLECTION:`), plus latest `n_cross=3` other-ticker entries **reflection-only** (or a 300-char decision excerpt). With `as_of`, an entry survives only if its stored `resolved:` date `<= as_of`; legacy entries with no resolution date are excluded conservatively.

Injection point: **only the Portfolio Manager** (`portfolio_manager.py:36-41`). `past_context` appears in exactly four places — `propagation.py:23/40`, `trading_graph.py:516-524`, `portfolio_manager.py:36-38` — despite the field docstring ("Memory log context injected at run start") and the reflection prompt's claim that it is "re-read by future analysts". No analyst, researcher, debator or trader reads it.

**And on the CLI path it is never computed at all**: `cli/main.py:1120-1125` calls `graph.propagator.create_initial_state(...)` without the `past_context` argument, so it defaults to `""`, and neither `store_decision` nor `_resolve_pending_entries` is ever called. **The entire memory/reflection subsystem is inert in the shipped CLI.**

---

## 6. Data layer (`tradingagents/dataflows/`)

### 6.1 Vendor routing (`interface.py`)

Categories (`interface.py:36-78`): `core_stock_apis` (`get_stock_data`), `technical_indicators` (`get_indicators`), `fundamental_data` (4 tools), `news_data` (`get_news`, `get_global_news`, `get_insider_transactions`), `macro_data` (`get_macro_indicators`), `prediction_markets` (`get_prediction_markets`).

Vendor set is exactly **yfinance, alpha_vantage, fred, polymarket** — plus out-of-band `reddit`/`stocktwits` fetchers called directly by the sentiment analyst. There is **no Finnhub, no SEC/EDGAR, no Google News API, no Polygon/Tiingo/IEX**.

`VENDOR_LIST` (`interface.py:80-85`) is **dead code** — repo-wide grep returns only its definition; the real default order is `VENDOR_METHODS` dict-key order (`:177,193`). Also note `get_global_news` is the one method with yfinance listed *before* alpha_vantage (`:128-131`).

Dispatch semantics (`interface.py:168-262`). The configured comma-separated value **is** the chain — there is no implicit fallback to unconfigured vendors:

```python
# interface.py:184-193
    explicit = [v for v in primary_vendors if v and v != "default"]
    if explicit:
        vendor_chain = [v for v in explicit if v in VENDOR_METHODS[method]]
        if not vendor_chain:
            raise ValueError(
                f"Configured vendor(s) {explicit} not available for '{method}'. "
                f"Available: {all_available_vendors}."
            )
    else:
        vendor_chain = all_available_vendors
```

Per-vendor reactions (`:203-221`): `VendorRateLimitError` → skip; `VendorNotConfiguredError` → skip + remember; `NoMarketDataError` → remember as `last_no_data` + skip; any other exception → log warning + skip. Terminal behaviour: clean no-data wins over incidental errors and returns an explicit sentinel —

```python
# interface.py:242-247
        return (
            f"NO_DATA_AVAILABLE: No usable market data for '{sym}'{resolved} from "
            f"any configured vendor{reason}. The symbol may be invalid, delisted, "
            f"not covered, or the vendor returned stale data. Do not estimate or "
            f"fabricate values — report that data is unavailable for this symbol."
        )
```
— while a real error on a core category is **re-raised** (`:260`) and on an optional category (`macro_data`, `prediction_markets`, `:92`) degrades to `"DATA_UNAVAILABLE: optional …"` (`:253-259`). Vendor precedence: `tool_vendors[method]` → `data_vendors[category]` → `"default"` (`:153-166`). Vendors can be set **only** by editing config / calling `set_config` — there is no env var or CLI flag for them.

Defaults (`default_config.py:139-150`): `core_stock_apis`, `technical_indicators`, `fundamental_data`, `news_data` → `yfinance`; `macro_data` → `fred`; `prediction_markets` → `polymarket`; `tool_vendors: {}`.

### 6.2 Caching

Exactly **one** on-disk cache, for OHLCV (`stockstats_utils.py:184-246`):

```python
    os.makedirs(config["data_cache_dir"], exist_ok=True)
    data_file = os.path.join(
        config["data_cache_dir"],
        f"{safe_symbol}-YFin-data-{start_str}-{end_str}.csv",
    )
```
where `start_str` = today−5y and `end_str` = tomorrow (`:200-207`). Because the **filename embeds today's date**, the cache key rolls over daily: a new file is written each day and nothing evicts the old ones. Default location `~/.tradingagents/cache` (`default_config.py:75`); the same directory also holds checkpoint DBs.

Freshness: `OHLCV_CACHE_TTL_SECONDS = 900` and `MAX_OHLCV_STALE_DAYS = 10` (`stockstats_utils.py:20,26`), applied by

```python
# stockstats_utils.py:179-181
    if curr_date_dt.date() < today_date.date():
        return False
    return time.time() - os.path.getmtime(data_file) > OHLCV_CACHE_TTL_SECONDS
```
so historical requests always reuse the cache while a current-day request refetches after 15 minutes (rationale: "Yahoo publishes a partial daily candle during market hours", `:172-176`). Empty/columnless cache files count as a miss (`:215-228`); empty downloads are never persisted ("Only cache real data — never persist an empty frame", `:240`). The cached CSV contains bars **through today**; truncation happens on read at `:251`.

Everything else is **uncached and re-fetched on every run** — news, fundamentals, statements, indicators, FRED, Polymarket, Reddit, StockTwits. The only other cache is `@functools.lru_cache(maxsize=256)` on `resolve_instrument_identity` (`agent_utils.py:92`), process-lifetime only.

### 6.3 Look-ahead / point-in-time handling

The strongest engineering in the repo. Shared primitives in `date_window.py`:

```python
# date_window.py:1-9 (module docstring)
"""Shared look-ahead-safe date-window filtering for dated content.

News, StockTwits, and Reddit all pull recent items that must be trimmed to the
analysis window so a historical/backtest run never sees content published after
its as-of date. Centralizing the rule keeps every source consistent (#1126,
#1220): every timestamp is normalized to UTC, the upper bound is exclusive at
midnight after ``end`` (so an item stamped exactly then can't leak), and an
undated item is kept only when the window reaches the present (a live run), since
in a backtest we can't prove it isn't future.
"""
```

```python
# date_window.py:35-49
def withhold_live_profile(curr_date: str | None, label: str) -> str | None:
    """Notice to serve instead of a live-only company profile, or None to serve it.

    Vendor "company overview" endpoints (yfinance ``Ticker.info``, Alpha Vantage
    ``OVERVIEW``) carry no historical vintage — not even name, sector and
    industry, which move when a company renames or is reclassified — so serving
    one into a run dated in the past leaks post-decision information (#1300).
    """
    if not curr_date:
        return None
    today = get_current_date()
    if curr_date >= today:
        return None
```

Mechanisms that **do** truncate: `load_ohlcv` (`stockstats_utils.py:251`, `data[data["Date"] <= curr_date_dt]` + `_assert_ohlcv_not_stale` `:130-164`); `filter_financials_by_date` dropping fiscal columns after `curr_date` (`stockstats_utils.py:278-289`); the Alpha Vantage equivalents (`alpha_vantage_fundamentals.py:7-28`, `:47-49`); news/global-news/Reddit/StockTwits via `in_window`; FRED vintage pinning:

```python
# fred.py:166-171
    # Pin the data vintage. FRED defaults both realtime bounds to today, serving
    # the LATEST revision of every observation; a single-day realtime interval
    # asks for the values known as of the pin instead, on both the metadata and
    # observations requests (#1275). Clamp to FRED's today: ...
    pit = min(curr_date, _fred_today())
    realtime = {"realtime_start": pit, "realtime_end": pit}
```
plus memory gating (`memory.py:82-84`).

**Where look-ahead still exists** (each verified):
1. **Polymarket is live-only** — `get_prediction_markets(topic, limit)` has no date parameter (`polymarket.py:68`); the only filter is "still open and resolves in the future" (`:47-65`). A backtest sees today's odds.
2. **Insider transactions have no as-of date** — `get_insider_transactions(ticker)` (`news_data_tools.py:49-51`; `y_finance.py:457-459`), so post-decision filings enter a historical run.
3. **Statement filtering keys on fiscal period END, not filing date** (`stockstats_utils.py:281-284`; `alpha_vantage_fundamentals.py:22-27`) — a quarter ending before `curr_date` but reported after it (typical 3–6 week lag) is still served.
4. **`curr_date=None` disables the filters**, and the three statement tools default it to `None` (`fundamental_data_tools.py:29,48,67`; `stockstats_utils.py:285-286`; `alpha_vantage_fundamentals.py:14-15`; `date_window.py:45-46`). `tests/test_alpha_vantage_hardening.py:90-92` asserts this passthrough as intended behaviour.
5. **`resolve_instrument_identity` bypasses the #1300 rule** — `@functools.lru_cache` over `yf.Ticker(normalize_symbol(ticker)).info` (`agent_utils.py:92,112-113`) with **no `curr_date` parameter**, injected into every agent prompt via `trading_graph.py:367-377` and `build_instrument_context` (`agent_utils.py:136-183`). The same name/sector/industry fields the data layer deliberately withholds still reach a historical run here.
6. The **verified snapshot bypasses vendor routing** and always uses yfinance (`market_data_validation_tools.py:23` → `market_data_validator.py:18,35`).

And globally: a past-dated run is not reproducible, because news/social content is whatever the vendor serves *today* (the repo says so itself, `README.md:270-272`).

### 6.4 Data source inventory

| Source | Module | Provides | Key | Default | Notes |
|---|---|---|---|---|---|
| **yfinance** | `y_finance.py`, `yfinance_news.py`, `stockstats_utils.py` | OHLCV (5y, CSV-cached), all technical indicators, fundamentals, 3 statements, insider transactions, ticker news, global news via keyword search | none | yes for 4 of 6 categories | free/unofficial; `yf_retry` retries `YFRateLimitError` 3× exp. backoff base 2s (`stockstats_utils.py:29-45`) |
| **Alpha Vantage** | `alpha_vantage*.py` | `TIME_SERIES_DAILY_ADJUSTED`, SMA/EMA/MACD/RSI/BBANDS/ATR (VWMA unimplemented, `alpha_vantage_indicator.py:140`), OVERVIEW, 3 statements, NEWS_SENTIMENT, INSIDER_TRANSACTIONS | `ALPHA_VANTAGE_API_KEY` (`alpha_vantage_common.py:30`) | opt-in | free tier ≈25 req/day — a fallback only; missing key → `VendorNotConfiguredError` |
| **FRED** | `fred.py` | vintage-pinned macro series by alias (`cpi`, `core_pce`, `unemployment`, `fed_funds_rate`, `10y_treasury`, `yield_curve`, `real_gdp`, `vix`) or raw series ID | `FRED_API_KEY` (`fred.py:93`) | yes for `macro_data` | free; `DEFAULT_LOOKBACK_DAYS=365`, `MAX_ROWS=40` (`:36,40`) |
| **Polymarket** (Gamma) | `polymarket.py` | market-implied probabilities, filtered to open + forward-looking | keyless (`:8-10,20`) | yes for `prediction_markets` | free; live-only, no date arg |
| **StockTwits** | `stocktwits.py` | cashtag stream with Bullish/Bearish tags; windowed | none | called unconditionally by the sentiment analyst | free/unofficial, 10s timeout, no retry |
| **Reddit** | `reddit.py` | r/wallstreetbets, r/stocks, r/investing; RSS fallback, 5 MiB cap, `Retry-After` capped 60s | none | called unconditionally by the sentiment analyst | free/unofficial, JSON search kept but unused (`:248-261` returns RSS-only) |
| **Finnhub / SEC / NewsAPI / Polygon / Tiingo / IEX** | — | — | — | **do not exist** | negative grep over all `.py/.toml/.example/.txt` |

Vendor HTTP timeouts exist per source (`polymarket.py:23` 30s, `fred.py:32` 30s, `stocktwits.py:70` 10s, `reddit.py:268` 10s) but there is no global run-level timeout.

### 6.5 Crypto support

First-class but partial.
- Detection is syntactic on the canonical symbol (`cli/utils.py:81-87`), with `CRYPTO_SUFFIXES = ("-USD", "-USDT", "-USDC", "-BTC", "-ETH")` (`cli/utils.py:23`).
- Normalization maps broker forms to Yahoo's `<BASE>-USD`, restricted to a hardcoded base set:

```python
# symbol_utils.py:44-47
_CRYPTO_BASES = frozenset(
    {"BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK"}
)
```
```python
# symbol_utils.py:76-80
# Crypto quote currencies that all map to Yahoo's USD pair. Yahoo lists only
# ``<BASE>-USD`` (not the USDT/USDC stablecoin pairs), so a broker symbol quoted
# in any of these resolves to ``-USD`` (#982). Longest first so ``USDT``/``USDC``
# match before the ``USD`` substring.
_CRYPTO_QUOTES = ("USDT", "USDC", "USD")
```
- The **only** graph-level behaviour change is dropping the fundamentals analyst (`cli/utils.py:90-99`) and relabelling "company" → "asset" with a caution (`bull_researcher.py:24-28`, `news_analyst.py:16-17`, `agent_utils.py:178-182`).
- Hard limits: any base outside those 11 is not detected as crypto (e.g. `PEPEUSD`); only `-USD` pairs exist (no USDT/USDC/perp/basis — `ETH-BTC` stays as typed because only USD/USDT/USDC quotes map, `symbol_utils.py:80,126-130`); **Alpha Vantage has no crypto handling at all** (symbol passed verbatim to equity endpoints; no `DIGITAL_CURRENCY_*` usage); the default benchmark remains `SPY` (`default_config.py:168`) unless `benchmark_ticker` is set, so "BTC alpha vs SPY" mixes a 24/7 asset with a US equity index; `_fetch_returns` uses yfinance bar offsets, so for crypto "5 days" means calendar days while for equities it skips weekends — the holding period is not comparable across asset classes; and there is no funding-rate, order-book, on-chain, or exchange data. `tests/test_crypto_asset_mode.py` covers labelling/filtering, not economics.

### 6.6 Symbol / path safety

`normalize_symbol` is purely syntactic (no network — `symbol_utils.py:116-117`), resolving explicit aliases (metals/energy/index CFDs, `:53-70`), then crypto, then 6-letter forex `PAIR=X`, else uppercase passthrough. `safe_ticker_component` (`dataflows/utils.py:12-37`) rejects traversal, over-length and dot-only values, with the threat model stated explicitly:

```python
# dataflows/utils.py:14-19
    Tickers come from user CLI input or from LLM tool calls, both of which
    can be influenced by attacker-controlled content (e.g. prompt injection
    embedded in fetched news). Without validation, a value like
    ``"../../../etc/foo"`` flows into ``os.path.join`` / ``Path /`` and
    escapes the configured cache, checkpoint, or results directory.
```

**Gap**: the CLI builds its artifact directory from the **raw** ticker without this helper — `results_dir = Path(config["results_dir"]) / selections["ticker"] / selections["analysis_date"]` (`cli/main.py:1034`) — while the programmatic logger sanitizes (`trading_graph.py:610`). The CLI validator accepts `.` characters (`cli/utils.py:33`), so a ticker of `..` would place the run directory one level above `results_dir`. Impact is bounded (checkpoint and cache paths do sanitize, and the run would fail at data fetch), but the asymmetry is real.

---

## 7. Execution / backtest reality check

**There is no execution layer.** Verified by exhaustive case-insensitive grep across the repo for `broker|order|place_order|submit_order|order_id|idempoten|backtest|position_siz|portfolio_value|pnl|fill_price|slippage|commission|alpaca|ibkr|interactivebrokers|ccxt|binance|coinbase|kraken`:

- **No broker or exchange integration.** The only `broker` hits are comments about *symbol naming conventions* (`symbol_utils.py:4-14`).
- **No order placement, order ids, fills, slippage, or commissions.** `TraderProposal.entry_price` / `stop_loss` / `position_sizing` are rendered to markdown (`schemas.py:189-204`) and discarded; nothing reads them back.
- **No portfolio state.** `AgentState` has no cash, position, quantity, exposure, or PnL key (`agent_states.py:47-76`). No equity curve exists anywhere.
- **No backtester.** `backtrader>=1.9.78.123` is a declared hard dependency (`pyproject.toml:13`) with **zero imports**. Same for `redis>=6.2.0` (`:25`), `langchain-experimental` (`:19`) and `parsel` (`:24`). There is no `tradingagents/backtest*` module and no backtest command.
- **No scheduler/daemon/cron.**
- **The CLI is a single interactive session.** `run_analysis` (`cli/main.py:1004-1301`) prompts for everything, streams one graph execution inside a `rich.Live` display, then ends with `save_choice = typer.prompt("Save report?", default="Y")` (`:1282`) and `display_choice = typer.prompt("\nDisplay full report on screen?", default="Y")` (`:1299`). The single command `analyze` (`:1304-1334`) exposes only `--checkpoint/--no-checkpoint` and `--clear-checkpoints`.
- **The decision's fate**: rendered in the live panel, always written to `<results_dir>/<ticker>/<date>/reports/final_trade_decision.md` via the section decorator (`cli/main.py:1063-1075`), optionally written as a full tree to `$(cwd)/reports/<TICKER>_<stamp>/`, printed, and displayed. **No exit code carries the decision, no webhook, no order.** On the programmatic path a 5-tier string is extracted (`trading_graph.py:574` → `signal_processing.py`), but the **CLI never calls `process_signal`**.
- **The only "backtest" affordance is date fidelity** — running the pipeline with a historical `trade_date` while the §6.3 guards keep price/statement/FRED/memory inputs honest. `README.md:285`: *"Backtest results are not guaranteed to match any published figure… Treat the framework as a research scaffold for studying multi-agent analysis, not as a strategy with a fixed, replicable return."*
- **The only P&L-like computation in the codebase** is the reflection alpha (§5.3) — a single 5-bar close-to-close return vs an index, used to score the memory log, not to simulate a portfolio.

---

## 8. Config surface

### 8.1 Every key in `DEFAULT_CONFIG` (28 keys)

`tradingagents/default_config.py:72-170`; env overrides applied at import via `_apply_env_overrides` (`:59-69`) with type coercion from the existing default (`:36-56`) — invalid values **raise** rather than silently defaulting.

| Key | Default | Consumers |
|---|---|---|
| `project_dir` | `…/tradingagents` | **read by nothing** |
| `results_dir` | `$TRADINGAGENTS_RESULTS_DIR` or `~/.tradingagents/logs` | `cli/main.py:1034`; `trading_graph.py:106,503,611` |
| `data_cache_dir` | `$TRADINGAGENTS_CACHE_DIR` or `~/.tradingagents/cache` | `stockstats_utils.py:209-213`; `checkpointer.py:19-25`; `trading_graph.py:105,446,451,490` |
| `memory_log_path` | `$TRADINGAGENTS_MEMORY_LOG_PATH` or `~/.tradingagents/memory/trading_memory.md` | `memory.py:21-24` |
| `memory_log_max_entries` | `None` (no rotation) | `memory.py:26,254` |
| `llm_provider` | `"openai"` | `trading_graph.py:116,122,171` |
| `deep_think_llm` | `"gpt-5.6"` | `trading_graph.py:117` |
| `quick_think_llm` | `"gpt-5.6-luna"` | `trading_graph.py:123` |
| `backend_url` | `None` (per-provider default) | `trading_graph.py:118,124` |
| `google_thinking_level` / `openai_reasoning_effort` / `anthropic_effort` | `None` | `trading_graph.py:174-186` |
| `temperature` | `None` | `trading_graph.py:191-193` (`float()`-coerced) |
| `llm_max_retries` | `None` (SDK default ≈2) | `trading_graph.py:197-199` |
| `max_tokens` | `None` | `trading_graph.py:203-206` (→ `max_output_tokens` for Google) |
| `checkpoint_enabled` | `False` | `trading_graph.py:443,488`; `cli/main.py:1000` |
| `output_language` | `"English"` | `agent_utils.py:62` → every agent prompt |
| `max_debate_rounds` | `1` | `trading_graph.py:138` → `conditional_logic.py:56` |
| `max_risk_discuss_rounds` | `1` | `trading_graph.py:139` → `conditional_logic.py:66` |
| `max_recur_limit` | `100` | `propagation.py:14,78` |
| `news_article_limit` / `global_news_article_limit` / `global_news_lookback_days` | `20` / `10` / `7` | `yfinance_news.py:79,143-145` |
| `global_news_queries` | 5 macro query strings | `yfinance_news.py:146` |
| `data_vendors` | see below | `interface.py:157,166` |
| `tool_vendors` | `{}` (takes precedence over category) | `interface.py:161-163` |
| `benchmark_ticker` | `None` | `trading_graph.py:263-265` (reflection only) |
| `benchmark_map` | 9 exchange suffixes + `"" → SPY` | `trading_graph.py:266-271` |

```python
# default_config.py:139-150
    "data_vendors": {
        "core_stock_apis": "yfinance",       # Options: alpha_vantage, yfinance
        "technical_indicators": "yfinance",  # Options: alpha_vantage, yfinance
        "fundamental_data": "yfinance",      # Options: alpha_vantage, yfinance
        "news_data": "yfinance",             # Options: alpha_vantage, yfinance
        "macro_data": "fred",                # Options: fred (needs FRED_API_KEY)
        "prediction_markets": "polymarket",  # Options: polymarket (keyless)
    },
    "tool_vendors": {
        # Example: "get_stock_data": "alpha_vantage",  # Override category default
    },
```

Note (`dataflows/config.py:16-30`) that `set_config` merges dict keys one level deep and replaces scalars, but the store is a **module-level global** — see §9.

### 8.2 Environment variables

`TRADINGAGENTS_*` config overrides (`default_config.py:10-29`), 15 vars:

```
TRADINGAGENTS_LLM_PROVIDER          → llm_provider
TRADINGAGENTS_DEEP_THINK_LLM        → deep_think_llm
TRADINGAGENTS_QUICK_THINK_LLM       → quick_think_llm
TRADINGAGENTS_LLM_BACKEND_URL       → backend_url
TRADINGAGENTS_OUTPUT_LANGUAGE       → output_language
TRADINGAGENTS_MAX_DEBATE_ROUNDS     → max_debate_rounds
TRADINGAGENTS_MAX_RISK_ROUNDS       → max_risk_discuss_rounds
TRADINGAGENTS_CHECKPOINT_ENABLED    → checkpoint_enabled
TRADINGAGENTS_BENCHMARK_TICKER      → benchmark_ticker
TRADINGAGENTS_TEMPERATURE           → temperature
TRADINGAGENTS_LLM_MAX_RETRIES       → llm_max_retries
TRADINGAGENTS_MAX_TOKENS            → max_tokens
TRADINGAGENTS_GOOGLE_THINKING_LEVEL → google_thinking_level
TRADINGAGENTS_OPENAI_REASONING_EFFORT → openai_reasoning_effort
TRADINGAGENTS_ANTHROPIC_EFFORT      → anthropic_effort
```

Read directly at import (not in the table, no coercion): `TRADINGAGENTS_RESULTS_DIR`, `TRADINGAGENTS_CACHE_DIR`, `TRADINGAGENTS_MEMORY_LOG_PATH` (`:74-76`). Setting provider/models/backend/language/rounds/thinking vars also **skips the corresponding interactive CLI prompt** (`cli/main.py:534-546,606-607,628,678,997-1000`). Not env-overridable: `memory_log_max_entries`, `max_recur_limit`, the news limits, `data_vendors`, `tool_vendors`, `benchmark_map`, `project_dir`.

Data keys: `FRED_API_KEY` (`fred.py:93`), `ALPHA_VANTAGE_API_KEY` (`alpha_vantage_common.py:30`). LLM keys are mapped per provider in `llm_clients/api_key_env.py:14-44` — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`/`DASHSCOPE_CN_API_KEY`, `ZHIPU_API_KEY`/`ZHIPU_CN_API_KEY`, `MINIMAX_API_KEY`/`MINIMAX_CN_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `MOONSHOT_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`; `None` for `bedrock` (AWS chain) and `ollama`. Plus `OLLAMA_BASE_URL`, `AZURE_OPENAI_DEPLOYMENT_NAME`, `AWS_REGION`/`AWS_DEFAULT_REGION`/`AWS_BEARER_TOKEN_BEDROCK`. `.env` and `.env.enterprise` auto-load at package import (`tradingagents/__init__.py:11-17`); the CLI can write a pasted key into `.env` (`cli/utils.py:645-649`). `.env.example` documents `FRED_API_KEY` but **not** `ALPHA_VANTAGE_API_KEY`.

### 8.3 Model catalog

`llm_clients/model_catalog.py` groups curated options into `quick`/`deep` per provider (`MODEL_OPTIONS`, `:98-208`) — 17 providers in the interactive picker (`cli/utils.py:338-366`), plus three region variants reachable only through follow-up prompts (`qwen-cn`, `glm-cn`, `minimax-cn`). OpenAI's Responses API is used only on the native endpoint (`openai_client.py:213,241-254`); a custom base_url keeps Chat Completions. Per-model API quirks (which model rejects `tool_choice`, needs `reasoning_content` round-trip, needs `reasoning_split`) live in a declarative table (`capabilities.py:29-46`) rather than `if` ladders. Validation warns rather than fails:

```python
# base_client.py:40-52
warnings.warn(
    (f"Model '{self.model}' is not in the known model list for "
     f"provider '{self.get_provider_name()}'. Continuing anyway."),
    RuntimeWarning, stacklevel=2,
)
```

### 8.4 Checkpointing

Off by default (`checkpoint_enabled: False`, `default_config.py:111`). When on, the graph is **recompiled with a per-ticker `SqliteSaver`**.

```python
# checkpointer.py:19-25
def _db_path(data_dir: str | Path, ticker: str) -> Path:
    """Return the SQLite checkpoint DB path for a ticker."""
    # Reject ticker values that would escape the checkpoints directory.
    safe = safe_ticker_component(ticker).upper()
    p = Path(data_dir) / "checkpoints"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{safe}.db"
```
→ default `~/.tradingagents/cache/checkpoints/<TICKER>.db`. Thread id = `sha256("<TICKER>:<date>:<signature>")[:16]` (`:28-38`), where the signature folds in graph-shape choices so a changed shape cannot silently resume (`trading_graph.py:390-402`): `analysts=…|debate=N|risk=M|asset=…`.

Lifecycle: `begin_checkpoint` compiles with the saver and returns the thread id (`:431-458`); `checkpoint_input` returns `None` on resume so LangGraph continues rather than re-appending the initial state (`:460-468`, #1249); `end_checkpoint` restores the plain graph (`:470-476`); `clear_checkpoint_on_success` deletes the thread's rows after a clean run (`:486-492`), so only crashed runs stay resumable. `--clear-checkpoints` deletes all per-ticker DBs (`cli/main.py:1312-1321`).

**Checkpointed**: the LangGraph `AgentState` only. **Not checkpointed**: the CLI `MessageBuffer` display state, `message_tool.log`, the incrementally-written `reports/*.md`, `StatsCallbackHandler` counters (they reset to zero after a resume), `AnalystWallTimeTracker` timings, the in-memory `trace` merge — and, on the CLI path, the memory log and state JSON, which are never written at all.

### 8.5 Observability

Token and call **counts only** — there is no pricing table, no currency, no cost figure anywhere in the repo. `StatsCallbackHandler` tracks `llm_calls`, `tool_calls`, `tokens_in`, `tokens_out` (`cli/stats_handler.py:12-18`), read from `AIMessage.usage_metadata` (`:47-56`), displayed in a rich footer (`cli/main.py:465-492`), and **never persisted**. There is **no `logging.basicConfig`/`dictConfig`/`addHandler` anywhere** — so vendor-failure warnings surface via Python's last-resort stderr handler while every `logger.info` (e.g. "Resuming from step %d") is silent. The only human-readable run log is `message_tool.log`. Network surfaces beyond the LLM/data vendors: a `https://api.tauric.ai/v1/announcements` GET with a 1s timeout at CLI startup (`cli/config.py:3-4`, `announcements.py:16-28`) and an OpenRouter model-list GET during selection (`cli/utils.py:216`).

---

## 9. Known weaknesses for a LIVE automated trading use case

Ordered by how quickly each would bite in production.

**9.1 There is nothing to execute with.** The final artifact is prose. No order object, broker adapter, fills, positions, or P&L (§7). Everything below concerns the analysis engine you would place in front of an execution layer you must write.

**9.2 The memory/reflection loop is inert in the shipped CLI.** Because `run_analysis` streams `graph.graph.stream(...)` directly (`cli/main.py:1144`) and never calls `propagate()`, the CLI — the documented entry point (`README.md:169`, `pyproject.toml:48-49`) — produces **no memory-log entry, no outcome resolution, no reflection, no `past_context`, and no `full_states_log_*.json`**, and never extracts a Buy/Hold/Sell signal. Every memory feature described in the README only exists for programmatic `TradingAgentsGraph.propagate()` callers. Any live system built on the CLI inherits none of the learning loop.

**9.3 No idempotency and no run identity.** A "decision" is keyed by `(ticker, trade_date)` but uniqueness is not enforced end-to-end:
- `_log_state` writes with `open(..., "w")` (`trading_graph.py:614-616`) — a re-run silently overwrites the prior decision for that date.
- `store_decision`'s guard only skips while an entry is still *pending* (`memory.py:40-44`); once resolved, a re-run appends a **second** entry for the same date, and `get_past_context` will later surface the ticker's own duplicates as distinct lessons.
- `thread_id` is deterministic on `(ticker, date, signature)` (`checkpointer.py:28-38`), so two concurrent runs of the same ticker+date collide on one SQLite thread.
- There is no decision id, content hash, or "already acted on" marker. An execution layer must supply its own dedupe key.

**9.4 The memory log is not concurrency-safe.** `update_with_outcome`/`batch_update_with_outcomes` do read-whole-file → modify → `tmp.replace()` (`memory.py:186-229`). `os.replace` is atomic but the read-modify-write window is **unlocked**, so two processes finishing different tickers concurrently each read the same pre-state and the second replace silently discards the first's reflection. `store_decision` has the same shape (`memory.py:40-49`). No file lock exists anywhere, and `redis` — the declared dependency that would provide one — is never imported. For continuous multi-ticker operation this is data loss, not a theoretical race.

**9.5 Global mutable config breaks multi-model / multi-tenant operation.** `dataflows/config.py:6` holds a module-level `_config`, and `TradingAgentsGraph.__init__` calls `set_config(self.config)` (`trading_graph.py:102`). Constructing a second graph with a different provider/vendor/language mutates the process-wide config that the first graph's tool calls read, since `get_config()` is called from deep inside vendor routing (`interface.py:157`). Running a cheap scanner model and a strong decision model in one process will cross-contaminate. Related: `self.curr_state`/`self.ticker`/`self.log_states_dict` are mutated by every run and `self.graph` is *replaced* during a checkpointed run and restored after (`trading_graph.py:448,475`) — the object is not safe to share across concurrent runs.

**9.6 Synchronous, blocking, no consumer-facing streaming, no clean cancellation.** `_run_graph` uses `self.graph.invoke(...)` (`trading_graph.py:556`); the CLI's `stream()` exists only to drive a display. No `async`, no queue, no per-stage callback. No signal handling exists in package code (`SIGINT`/`SIGTERM`/`KeyboardInterrupt` never caught), so a kill leaves a half-written report tree and possibly an unresolved memory entry. The only cancellation-adjacent mechanism is the recursion limit (`max_recur_limit: 100`), which raises rather than degrades.

**9.7 Cost and latency are unbounded and unmetered.** One `(ticker, date)` run executes, at defaults: 4 analyst tool loops (the market analyst alone is asked for up to **8 indicators** plus a snapshot, so 10+ LLM calls there), 2 debate speeches, 1 RM call, 1 trader call, 3 risk speeches, 1 PM call — low tens of LLM calls per ticker, with the two deep-think calls carrying all four analyst reports plus the entire debate transcript. Then `_resolve_pending_entries` fires **one more LLM call per pending entry** with no cap (`trading_graph.py:348-353`). The only telemetry is `StatsCallbackHandler`, wired **only by the CLI** (`cli/main.py:1011,1024`); programmatic users get nothing. There is no cost model, no budget, no per-run ceiling, and no rate limiter beyond `llm_max_retries` and per-vendor HTTP timeouts.

**9.8 Reflection depends on future data and on re-running the same ticker.** A decision can never be scored during its own run. `_fetch_returns` requires `holding_days + 7` calendar days of subsequent bars and refuses to settle on a partial window (`trading_graph.py:291-304`), and `_resolve_pending_entries` only processes entries **for the ticker currently being analysed** (`:336`). So: a one-shot run or a ticker analysed once never produces a reflection; a decommissioned ticker's pending entries stay pending forever (rotation only drops *resolved* blocks, `memory.py:254,276-282`); and in a live deployment the feedback loop lags at least a week and depends on the scheduler revisiting the same symbol. The repo acknowledges the trade-off: *"Trade-off: only same-ticker entries are resolved per run. Entries for other tickers accumulate until that ticker is run again."* (`trading_graph.py:333-334`).

**9.9 The reflection metric is a weak proxy for a live book.** Entry is the close of the first bar on/after `trade_date` (`trading_graph.py:297,307`) — the strategy implicitly assumes it can transact at the analysis-date close, unavailable if analysis runs after the close. Returns are **bar offsets** (`iloc[0]` → `iloc[holding_days]`), so "5 days" is five rows in that instrument's series — calendar days for crypto, trading days for equities — making the holding period non-comparable across asset classes. Alpha is a naive `raw - bench_ret` with no beta, currency adjustment, dividends, or borrow costs; for non-US tickers `raw` is in local currency while `benchmark_map` picks a local index, which is self-consistent, but the docstring's claim that "the alpha calculation works in USD" (`trading_graph.py:260-261`) does not hold there. And `_fetch_returns` bypasses vendor routing entirely by calling `yf.Ticker(...)` directly (`:297-298`), so it ignores `data_vendors`.

**9.10 Signal parsing is a regex over LLM prose, with one inconsistency.** `extract_rating` (`rating.py:45-66`) is the only bridge from the PM's decision to an actionable signal. The two-pass design and the `REVIEW` sentinel are good, but:
- `SignalProcessor` returns `"REVIEW"` (`signal_processing.py:37-38`) while the memory log uses `parse_rating`, which coerces unparseable output to **`"Hold"`** (`memory.py:45`, `rating.py:69-78`). An unparseable decision is signalled `REVIEW` to the caller but recorded as a neutral `Hold` in the very history the reflection layer learns from — the #1170 fix was not carried through.
- When the structured call fails, `invoke_structured_or_freetext` retries as free text with no schema (`structured.py:82-88`), and `bind_structured` silently degrades for providers lacking `with_structured_output` (`:48-56`). Both are log warnings, not surfaced in the return value.
- The rating is coarse (5 tiers, no size/confidence/horizon as machine fields); `price_target` and `time_horizon` are `Optional` and unconsumed.

**9.11 No risk controls, by construction.** No kill-switch, daily-loss limit, max-position, max-exposure, or circuit breaker — grep for `kill|halt|daily_loss|max_position|position_limit|risk_limit` returns only prose in prompts. `stop_loss` and `position_sizing` are LLM-authored *strings* (`schemas.py:163-174`) rendered to markdown and dropped; nothing validates or enforces them, and the validator even *deletes* a percentage rather than converting it (`schemas.py:33-50`). The risk debate that nominally serves as the control function is three quick-model personas emitting conversational prose (`aggressive_debator.py:42`), one of which is explicitly instructed to advocate *for* the trader's proposal. Any real risk layer must be built outside this repo.

**9.12 Non-determinism is acknowledged and irreducible.** `README.md:267-283`: reasoning models sample their own reasoning, temperature is ignored by the default models, and social/news inputs differ between a historical and a live run. Structured output reduces *format* variance, not *content* variance. Two runs of the same ticker and date can produce different ratings — "the system's decision" is not a stable object you can audit or replay.

**9.13 Data-integrity gaps that matter for historical evaluation.** The §6.3 look-ahead gaps are individually bounded but they compound: Polymarket odds and insider filings are live-only; statement filtering keys on fiscal period end, not filing date; the statement tools default `curr_date=None`, which disables filtering entirely; and `resolve_instrument_identity` injects a cached live `Ticker.info` (name/sector/industry) into every agent prompt with no date guard, bypassing the repo's own #1300 withholding rule. A historical run therefore still sees some post-decision information.

**9.14 Operational sharp edges.**
- **Unbounded disk growth**: a new OHLCV CSV per symbol per day with no eviction (`stockstats_utils.py:210-213`); resolved memory entries never rotated unless `memory_log_max_entries` is set (default `None`); one `full_states_log_<date>.json` per analysed date.
- **Prompt-injection surface**: `safe_ticker_component`'s docstring names "prompt injection embedded in fetched news" as a real threat, yet fetched news/social text is interpolated raw into prompts. The blast radius is a bad decision rather than an arbitrary action (the decision agents have no tools) — but a bad decision is the entire product.
- **Vendor fragility**: four of six categories default to undocumented Yahoo endpoints; Reddit/StockTwits are unofficial and rate-limited; the only retry logic is `yf_retry` plus SDK retries; and a core-category vendor failure **raises** out of `route_to_vendor` (`interface.py:260`), aborting the run mid-graph.
- **CLI path asymmetry**: the CLI uses the raw ticker as a path component (`cli/main.py:1034`) where the programmatic path sanitizes (`trading_graph.py:610`).
- **Dead surfaces**: `main.py:19` references the removed `reflect_and_remember`; `pyproject.toml` declares four unused dependencies including `backtrader`; `dataflows/interface.py:80-85` `VENDOR_LIST` is unreferenced; `agents/utils/agent_utils.py:231` and `agents/analysts/social_media_analyst.py` are deprecation shims; `cli/utils.py:102 get_analysis_date` is dead code shadowed by `cli/main.py:744`.

---

## What is worth reusing vs. what must be rebuilt

### Worth reusing (as-is or with light wrapping)

1. **The point-in-time discipline in the data layer.** The most valuable and least replaceable asset here: `date_window.py`'s single shared UTC half-open window, `withhold_live_profile`, FRED `realtime_start/realtime_end` vintage pinning, `filter_financials_by_date`, and memory `resolved <= as_of` form a coherent, cross-vendor, test-backed story (`tests/test_*lookahead*.py`, `test_memory_pointintime.py`, `test_fred.py`, `test_ohlcv_cache_freshness.py`). Keep it wholesale, then close the five gaps in §6.3.
2. **The vendor-routing contract.** `interface.py`'s explicit-chain semantics, behavioural error taxonomy (`errors.py`), `NO_DATA_AVAILABLE` / `DATA_UNAVAILABLE` sentinels that instruct the model not to fabricate, and the core-vs-optional category split. Add vendors by extending `VENDOR_METHODS`. (Fix: make it env/flag-configurable, and retire the dead `VENDOR_LIST`.)
3. **`schemas.py` + `structured.py`.** Typed Pydantic output for the three decision agents, per-provider native structured modes, documented free-text fallback, and **render-back-to-markdown** so storage/display/parsing share one shape. The `_coerce_optional_float` handling of LLM numeric garbage (`"N/A"`, `"$1,234.50"`, `"15%"`) is hard-won detail worth copying.
4. **The 5-tier rating vocabulary and the `REVIEW` sentinel** (`rating.py`, `signal_processing.py`). One shared scale across RM/PM/memory/signal is right, and refusing to fabricate a `Hold` on parse failure is the correct default (just propagate it to the memory log).
5. **`symbol_utils.normalize_symbol`.** Purely syntactic, no network, covers broker/CFD/forex/crypto/index aliases, and the alias tables are data not code. Directly reusable in front of any venue's symbol space.
6. **Path-safe ticker handling** (`dataflows/utils.py:safe_ticker_component`) and the general instinct to validate LLM-influenced values before filesystem interpolation — apply it on the CLI path too.
7. **The graph shape as a reference design.** Analysts → adversarial research debate → judge → trader → adversarial risk debate → judge is legible and debuggable, and the `Msg Clear <X>` pattern (wipe per-analyst context so one analyst's tool chatter cannot pollute the next) is a genuinely good idea that keeps context small and prevents cross-analyst anchoring.
8. **The checkpoint/resume design** (`checkpointer.py`): per-ticker SQLite, thread id hashed from `(ticker, date, graph-shape signature)`, resume-by-invoking-with-`None`, clear-on-success. The signature idea is the correct fix for "resumed into a different graph".
9. **The model/provider layer**: lazy provider imports, a declarative per-model capability table (`capabilities.py`), a single provider→env-var map (`api_key_env.py`), and a curated-but-overridable catalog. Good bones for a multi-provider service.
10. **`reporting.write_report_tree`** — a deterministic, sectioned markdown audit artifact.

### Must be rebuilt (do not extend in place)

1. **Execution and portfolio accounting — entirely absent.** Broker adapter, order lifecycle with client-generated idempotency keys, position/PnL ledger, corporate actions and fees, reconciliation against broker state. `TraderProposal` is a starting *schema*, not an implementation.
2. **Risk control — entirely absent and actively misleading.** A deterministic pre-trade gate (position/exposure/notional limits, per-symbol and portfolio drawdown, volatility-scaled sizing, session/trading-hours checks), a post-trade monitor, and a kill-switch with a defined flatten procedure. Treat the in-graph risk debate as *commentary*, never as authorization, and never let `position_sizing`/`stop_loss` strings reach an order without independent numeric derivation.
3. **The entry point itself.** Either wire the memory/reflection path into the CLI or drop the CLI and build on `propagate()`. As shipped, the two paths produce materially different systems (§9.2) — that divergence must be resolved before anything else.
4. **Run orchestration and durability.** A job/queue model with explicit run ids, a durable run record, at-least-once semantics with idempotent side effects, retry with backoff, per-run timeouts and cancellation, and a scheduler that revisits symbols so reflection can actually resolve. LangGraph checkpointing covers graph state only and is off by default.
5. **Concurrency and configuration isolation.** Fix the module-global `_config` (`dataflows/config.py:6`) by threading config explicitly or via contextvars; put a real lock (or a database) around the memory log's read-modify-write; stop mutating `self.graph` on a shared object during checkpointed runs.
6. **The memory/reflection loop.** The concept (log the decision, score it later, write a short lesson, feed it back) is sound. The implementation needs: resolution decoupled from "someone re-ran this exact ticker" (a separate scoring job over all pending entries); a holding-period model matching how you actually trade; trade-level not decision-level returns (sized, net of costs); the rating recorded from the parsed signal rather than a silent `Hold` default; dedupe by run id; atomic multi-writer storage (SQLite/Postgres, not a markdown file); and bounded retention.
7. **Signal → action translation.** Replace the regex-over-prose bridge with a contract: a typed decision object with rating, size, horizon, invalidation level, and confidence, validated against policy before it can reach an order. Keep `REVIEW` as a first-class "do not trade, escalate" outcome and make every consumer honour it.
8. **Cost, budget and observability.** Per-run token/cost accounting in the *library* path, a hard per-run and per-day spend ceiling, latency SLOs, structured logs with run ids, metrics per node, and `logging.basicConfig` so warnings and infos are actually visible. `StatsCallbackHandler` is a display widget.
9. **Determinism and auditability for live decisions.** Pin model versions rather than floating aliases, record the full prompt/response corpus per run, hash the inputs (including vendor payloads), and treat a rating change at fixed inputs as an incident. The repo explicitly disclaims reproducibility — for live trading that is a requirement, not a caveat.
10. **Vendor redundancy for anything you depend on.** Configure explicit multi-vendor chains (`"yfinance,alpha_vantage"`), add a paid primary for prices and fundamentals, and make orchestration treat a data outage as "skip this cycle", not "crash".
11. **The debate loops, if cost matters.** Fixed-length, always-ends-on-the-Bear, no convergence test, no confidence signal, full transcript re-injected into every subsequent prompt and both judges. Either shorten it, summarize between rounds, or run it only when the cheap path is genuinely undecided.
