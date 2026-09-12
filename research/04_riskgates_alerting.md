# Risk Gates & Alerting at Real Desks — Q6 and Q8

Research brief. Every claim below is followed by a link to a URL that was actually fetched during this research. Quality flags:

- **[PRIMARY]** — regulator / exchange / firm's own rules / named practitioner's own words / SEC filing
- **[SECONDARY]** — journalism, trade press, reputable summary of a primary source
- **[FOLKLORE]** — unsourced blog assertion, SEO content, affiliate marketing

**Headline finding:** across every population examined — prop firms, the original Turtle rules, money-centre banks, and securities/derivatives regulators — risk gates are specified as *pre-set numbers enforced by something other than the trader*: an automated pre-trade gateway, a liquidation engine, an independent risk function, or an exchange. Discretion exists, but it is exercised *before* the trade (sizing, mandate) and in *escalation* (temporary limit increases granted by risk, not by the trader). Monitoring, correspondingly, is exception-based: pagers/alerts fire on breach, and continuous screen-watching is explicitly framed as a failure mode rather than a virtue.

---

# Q6. RISK GATES AND LIMITS AT REAL DESKS

## 6.1 Prop firm rules — the actual numbers from the firms' own pages

### FTMO (CFD)

All figures below are from FTMO's own Trading Objectives page, which is the contractual rule page.

**FTMO Challenge: 2-Step** (the classic product) [PRIMARY — firm's own rules page](https://ftmo.com/en/trading-objectives/):

| Objective | Number |
|---|---|
| Profit Target — Challenge | **10%** of Initial Simulated Capital |
| Profit Target — Verification | **5%** of Initial Simulated Capital |
| Maximum Daily Loss | **5%** of Initial Simulated Capital |
| Maximum Loss | **10%** of Initial Simulated Capital, **static** |
| Minimum Trading Days | **4** |

**FTMO Challenge: 1-Step** [PRIMARY — firm's own rules page](https://ftmo.com/en/trading-objectives/):

| Objective | Number |
|---|---|
| Profit Target | **10%** |
| Maximum Daily Loss | **3%** |
| Maximum Loss | **10%**, **end-of-day trailing** |
| Best Day Rule | Best Day must not exceed **50%** of Positive Days' Profit |

FTMO's own definitions (quoted verbatim):

- Daily loss: *"The Maximum Daily Loss rule establishes a limit (the Maximum Daily Loss Limit) below which your account equity (i.e., Balance + Open Positions P/L ± Swaps – Commissions) cannot drop. If the equity drops below this limit, the rule is considered violated."* [PRIMARY](https://ftmo.com/en/trading-objectives/)
- The daily limit is **recalculated every day at 00:00 CE(S)T** as `balance at midnight − 5% of Initial Simulated Capital`. Worked example given by FTMO for a $100,000 account: Day 1 limit = $95,000; if balance at midnight is $102,000, Day 2 limit = $97,000; if balance is then $101,000, Day 3 limit = $96,000. Note the limit can move *down* as well as up. [PRIMARY](https://ftmo.com/en/trading-objectives/)
- **1-Step** trailing max loss: *"The limit can only increase, but never decrease."* [PRIMARY](https://ftmo.com/en/trading-objectives/)
- **2-Step** max loss is static: *"The Maximum Loss rule establishes a static limit… Limit = $90,000"* for a $100k account. [PRIMARY](https://ftmo.com/en/trading-objectives/)

**Consistency rule (1-Step only).** FTMO calls it the **Best Day Rule**: *"the Best Day Rule requires that your Best Day does not represent more than 50% of your Positive Days' Profit."* Crucially, it is **not** an instant breach: *"Exceeding the Best Day limit is not treated as a rule breach. However, you need to continue trading to generate additional profit until your Best Day… represents 50% or less."* In FTMO's worked example, a $10,000 best day against $16,000 of positive-day profit (62.5%) means the trader must reach $20,000 of positive-day profit. [PRIMARY](https://ftmo.com/en/trading-objectives/)

**News / weekend / EA rules.** These live on the **Forbidden Trading Practices** page [PRIMARY — firm's own rules page](https://www.ftmo.com/en/forbidden-trading-practices/). Directly quoted:
- *"perform gap trading… by opening simulated trades: when major global news, macroeconomic events, or corporate reports or earnings are scheduled and they might affect the relevant financial market; or two hours or less before a relevant financial market is closed for at least two hours"* — i.e. it is **gap trading around news**, not all news trading, that is banned, plus a **2-hour pre-close blackout**.
- Automated systems: no *"automated robots / EAs (Expert Advisors) which cause the trading account to become hyperactive in the sense of an excessive number of more than 2,000 server requests per day."*
- *"use trading strategies that artificially distribute profit across multiple days without proportionally distributing market risk, such as hedging or holding opposing positions on the same or highly correlated instruments… in order to circumvent the Best Day Rule."*
- Simultaneous opposite positions are banned *"with the exception of entering into such positions on a single simulated account."*
- Risk-management-style gate: *"opening substantially larger position sizes compared to your other simulated trades"* is listed as a practice not reasonably replicable in the real market.
- FTMO states these rules are *"mandatory and is your main responsibility"* and that breaches may be handled by the firm, not the trader.

### Topstep (futures)

Topstep advertises a single hard rule — the **Maximum Loss Limit (MLL)**. From Topstep's own Help Center [PRIMARY — firm's own help documentation](https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit):

| Account Size | Maximum Loss Limit |
|---|---|
| $50K | **$2,000** |
| $100K | **$3,000** |
| $150K | **$4,500** |

Mechanics, quoted:
- *"The Maximum Loss Limit (MLL) is the lowest point your account balance is allowed to reach. If your balance hits it at any point during the trading day, including on unrealized P&L, your account is liquidated immediately."*
- *"The MLL is a trailing limit. It rises as your end-of-day balance grows, but never moves down. Once it reaches your starting balance, it locks permanently."*
- *"Maximum Loss Limits cannot be adjusted or changed on your account. Topstep does not make exceptions to the Maximum Loss Limit for any account."*
- *"Risk limits are monitored in real-time using Net P&L — both realized and unrealized. If your account touches or falls below a limit at any point, it's a violation and liquidation triggers immediately."*
- On the apparent paradox of a final balance above the limit: *"When liquidation fires, positions close via market orders. Slippage and price movement during execution can push your final realized balance back above the limit — but the violation already happened based on unrealized P&L."*
- Consequence: Express Funded Account *"is permanently closed"*; Trading Combine account *"is liquidated for the rest of the trading day and becomes ineligible for funding until you Reset."*
- Topstep also runs a **"Path to Reduction"**: *"If your account balance takes a large drop from its highest balance, our Risk Team will review performance and may reach out with a Shoulder Tap."* [PRIMARY — Topstep's own FAQ page](https://www.topstep.com/faq/) — note this is a *discretionary human review triggered by a mechanical drawdown metric*.

This is the cleanest single piece of evidence in the whole brief that these gates are mechanical: the limit is on **unrealized** P&L, checked in real time, and **liquidation fires before the human can act**. Topstep explicitly says a final balance above the limit does not matter.

### The5ers

The5ers' numbers are less reliably available from its own site (its program and help pages returned 404/JS-only on fetch). The best available summary — flagged accordingly — reports [SECONDARY — third-party rules aggregator, TradingFinder](https://tradingfinder.com/props/the-5ers/rules/):
- Bootcamp: Phase 1 profit target **6%**, Phase 2 **6%**, Phase 3 **6%**; Maximum Daily Drawdown **3%–5%**; maximum drawdown **5%–10%** depending on program.
- High-Stakes: *"Phase 1 has an 8% profit target, Phase 2 has a 5% profit target, and the maximum loss is 10%."*
- Prohibited: *"high-frequency trading, news trading, copy trading, hedging, arbitrage."*
- Weekend holding: *"The 5ers allows traders to hold positions both overnight and over the weekend"* — but swap costs apply (Crude Oil swap quoted as −$20, increasing tenfold over the weekend).

**Honesty flag:** the 6%/5%/8%/10% The5ers figures are from a third-party aggregator, not from The5ers' own rule page (which I could not retrieve). Treat as **[SECONDARY]**, not primary. Nothing from The5ers' own domain could be fetched successfully except its marketing homepage.

### The "MyForexFunds-style" firm

Not researched in depth here beyond FTMO/Topstep/The5ers; MyForexFunds itself was shut down by the CFTC in 2023 (see "What I could not find").

---

## 6.2 The original Turtle rules — what the document actually says (and what it doesn't)

The authoritative text is the **"Original Turtle Trading Rules"** document (the "Free Rules Project" write-up by an original Turtle, widely mirrored). I fetched the full text [PRIMARY — original rules document, mirrored](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf). Its content is independently corroborated by a **granted patent** that reproduces the position-limit rules [PRIMARY — patent specification reproducing the rules](https://patents.google.com/patent/EP1941442A1/en).

### Position unit sizing
- *"Units were sized so that 1 N represented 1% of the account equity."* With `Unit = (1% of Account) / (N × Dollars per Point)`. [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)
- N is *"the 20-day exponential moving average of the True Range, which is now more commonly known as the ATR."* [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)

### The unit limits — exact text and numbers
Quoted table from the document [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf):

| Level | Type | Maximum Units |
|---|---|---|
| 1 | Single Market | **4 Units** |
| 2 | Closely Correlated Markets | **6 Units** |
| 3 | Loosely Correlated Markets | **10 Units** |
| 4 | Single Direction – Long or Short | **12 Units** |

- *"Single Markets – A maximum of four Units per market."*
- *"Closely Correlated Markets – For markets that were closely correlated there could be a maximum of 6 Units in one particular direction (i.e. 6 long units or 6 short units). Closely correlated markets include: heating oil and crude oil; gold and silver; Swiss franc and Deutschmark; TBill and Eurodollar, etc."*
- *"Loosely Correlated Markets – For loosely correlated markets, there could be a maximum of 10 Units in one particular direction."*
- *"Single Direction – The maximum number of total Units in one direction long or short was 12 Units. Thus, one could theoretically have had 12 Units long and 12 Units short at the same time."*
- Patent corroboration: *"no more than 4 units in any single instrument, no more than 6 units in any given direction in closely correlated markets, no more than 10 units in any direction in weakly correlated markets, and no more than 12 units in any direction in total."* [PRIMARY](https://patents.google.com/patent/EP1941442A1/en)

**Note: the commonly cited "6 units max per correlated market" is correct; the "12-unit total limit" is a per-direction limit, and there is also a 10-unit loosely-correlated tier that is usually omitted from summaries.**

### The 2% risk rule
- *"Stop Placement: The Turtles placed their stops based on position risk. No trade could incur more than 2% risk. Since 1 N of price movement represented 1% of Account Equity, the maximum stop that would allow 2% risk would be 2 N of price movement. Turtle stops were set at 2 N below the entry for long positions, and 2 N above the entry for short positions."* [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)
- Alternate "Whipsaw" stop: *"Instead of taking a 2% risk on each trade, the stops were placed at ½ N for ½% account risk."* [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)

### THE DRAWDOWN DE-RISKING RULE — the key find, and a correction to the popular claim
The original document contains **no "6% monthly / 10% annual stop-trading" rule.** What it actually contains is a **step-down in notional account size after drawdown**, quoted in full [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf):

> *"The Turtles were instructed to decrease the size of the notional account by 20% each time we went down 10% of the original account. So if a Turtle trading a $1,000,000 account was ever was down 10%, or $100,000, we would then begin trading as if we had a $800,000 account until such time as we reached the yearly starting equity. If we lost another 10% (10% of $800,000 or $80,000 for a total loss of $180,000) we were to reduce the account size by another 20% for a notional account size of $640,000. There are other, perhaps better strategies for reducing or increasing equity as the account goes up or down. These are simply the rules that the Turtles used."*

So the mechanism is: **20% size reduction per 10% drawdown, compounding ($1,000,000 → $800,000 → $640,000), with re-gearing back to the yearly starting equity.** It is a *de-risking ladder*, not a *stop-trading switch*.

The document also contains a "Failsafe Breakout" (the 55-day breakout used when a System 1 signal is skipped) — but that is an *entry* failsafe, not a *stop-trading* failsafe. [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)

### On why rules beat discretion
Richard Dennis, quoted in the document: *"I always say that you could publish my trading rules in the newspaper and no one would follow them. The key is consistency and discipline."* (attributed to Schwager, *Market Wizards*). [PRIMARY — quoted in the rules document](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)

Covel's site (the main populariser of the Turtle story) frames the 2% idea as *"Small betting — for example, 2 percent of $10,000 on initial bets — kept them in the game to play another day"* [SECONDARY — Michael Covel / TurtleTrader.com](https://www.turtletrader.com/rules/); note this page asserts the rules but does **not** reproduce the 6%/10% stop-trading rule either.

A third-party summary claims *"The maximum trade size a Turtle would take on any position was 2% of the account balance"* [SECONDARY — ForexTrainingGroup](https://forextraininggroup.com/the-original-turtle-trading-story-and-rules/) and separately gives the unit caps as *"A single position was limited to 4 units. For holding a position in multiple markets, the Turtles could have a total of 10 units"* — this **conflates the 10-unit loosely-correlated tier with a 12-unit total**, which the primary document contradicts.

---

## 6.3 Bank / hedge-fund risk limits — hard limits, independent risk, and escalation

The best primary evidence is a money-centre bank's own SEC filing, because the language is legally reviewed.

### JPMorgan Chase, 2025 Form 10-K (SEC EDGAR) [PRIMARY — SEC filing]

**Independent Risk Management and the CRO reporting line:**
> *"The Firm has an Independent Risk Management ('IRM') function, which is comprised of Risk Management and Compliance. The Firm's Chief Executive Officer ('CEO') appoints, subject to approval by the Risk Committee of the Board of Directors (the 'Board Risk Committee'), the Firm's Chief Risk Officer ('CRO') to lead the IRM function and maintain the risk governance framework of the Firm."*
>
> *"The Firm's CRO oversees and delegates authority to the Firmwide Risk Executives ('FREs'), the Chief Risk Officers of the LOBs and Corporate ('LOB CROs'), and the Firm's Chief Compliance Officer ('CCO')…"*
>
> *"Each area of the Firm that gives rise to risk is expected to operate within the parameters identified by the IRM function, and within the risk and control standards established by its own management."*

[PRIMARY — JPMorgan Chase 2025 Form 10-K, via SEC EDGAR](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm)

Note the structure: the **CRO is appointed by the CEO but requires Board Risk Committee approval** — i.e. the risk function's authority is board-derived, and the business is required to operate *within parameters set by risk*, not parameters it sets itself.

**Limits, who sets them, and what happens on a breach** (quoted in full — this is the single most important passage in the brief):
> *"Market risk exposure is managed primarily through a series of limits set in the context of the market environment and business strategy… Market Risk Management maintains different levels of limits. Firm level limits include VaR and stress limits. Similarly, LOB and Corporate limits include VaR and stress limits and may be supplemented by certain nonstatistical risk measures such as profit and loss drawdowns."*
>
> *"Market Risk Management sets limits and regularly reviews and updates them as appropriate. Senior management is responsible for reviewing and approving certain of these risk limits on an ongoing basis. Limits that have not been reviewed within specified time periods by Market Risk Management are reported to senior management. The LOBs and Corporate are responsible for adhering to established limits against which exposures are monitored and reported."*
>
> *"Limit breaches are required to be reported in a timely manner to limit approvers, which include Market Risk Management and senior management. In the event of a breach, **Market Risk Management consults with senior members of appropriate groups within the Firm to determine the suitable course of action required to return the applicable positions to compliance**, which may include a reduction in risk in order to remedy the breach or granting a temporary increase in limits to accommodate an expected increase in client activity and/or market volatility. Firm, Corporate or LOB-level limit breaches are escalated as appropriate."*

[PRIMARY — JPMorgan Chase 2025 Form 10-K](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm)

**Three things this establishes:**
1. **The limit setter is the risk function, not the desk.** *"Market Risk Management sets limits."* The business's obligation is *"adhering"*.
2. **The breach remedy is decided by risk, not the trader.** Market Risk Management *"determine[s] the suitable course of action required to return the applicable positions to compliance"* — reduction of risk, or a temporary limit increase.
3. **Limit breaches are an escalation workflow, not a conversation.** Breaches go to *"limit approvers"* and are *"escalated as appropriate"*.

**Drawdown IS a bank risk limit.** The JPM 10-K lists, among market risk measures: *"Stress testing / Profit and loss drawdowns / Earnings-at-risk / Economic value sensitivity / Other sensitivity-based measures"*, and states that *"LOB and Corporate limits include VaR and stress limits and may be supplemented by certain nonstatistical risk measures such as profit and loss drawdowns."* [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm) — **This is direct evidence that peak-to-trough P&L drawdown is used as a *limit* at a systemic bank, not merely as a reporting statistic.**

**VaR limit calibration.** JPM's *Regulatory VaR* is described as assuming *"a ten business-day holding period and an expected tail-loss methodology which approximates a 99% confidence level."* [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm)

### JPMorgan SE (the EU legal entity) — even more explicit escalation language
From JPMorgan's own published annual report [PRIMARY — JPMorgan 2024 Annual Report PDF](https://www.jpmorgan.com/content/dam/jpm/global/disclosures/de/english-version-of-disclosures/2024-annual-report-english.pdf):
- *"The risk limits which are set below the Risk Appetite introduce additional levels of escalation."*
- *"A market risk valid limit breach requires that the business takes immediate steps to reduce exposure so as to be within limit, unless a temporary limit increase is granted."*
- *"Aged or significant market risk limit breaches are escalated by Market Risk to [senior management]."*
- *"Limit breaches are required to be reported in a timely manner to limit approvers."*
- *"JPMorgan SE's CEO, CRO and MRO are limit approvers of VaR & Stress limits for the legal entity which are Risk Appetite early indicators."*
- *"There are pre-approved actions to take in the event of limit breaches."*
- Market Risk reports include *"daily notification of limit utilizations and limit breaches."*

Note the two-tier structure — a **soft tier** (Risk Appetite indicators, "early indicators", *"introduce additional levels of escalation"*) sitting above a **hard tier** (valid limit breaches requiring *"immediate steps to reduce exposure"*). That is the soft-limit / hard-limit distinction in the wild, in a primary document.

### Soft vs hard limits, in an industry association submission
AFME (Association for Financial Markets in Europe), responding to a PRA consultation [PRIMARY — AFME response letter PDF](https://www.afme.eu/Portals/0/DispatchFeaturedImages/AFME%20response%20-%20Large%20Exposures%20CP%20(002).pdf):
- *"the flexibility granted by Article 396 for firms to exceed the limits in 'exceptional circumstances' subject to reporting the exposure to the PRA… may not provide the same outcome as a temporary 'soft' limit in this context"*
- *"the current soft limit is operating in an effective manner to limit concentration risk whilst permitting some flexibility to manage exposures deriving from market price movements which firms cannot anticipate in advance."*

### Where I looked for "risk limits are hard limits" and did not find it
I ran EDGAR full-text search for the exact phrases `"risk limits are hard limits"` and `"hard risk limits"` across all filings: **both returned 0 results**. `"hard limits"` in 10-Ks returned only 30 hits, none from a bank's market-risk section. [PRIMARY — SEC EDGAR full-text search API, https://efts.sec.gov/LATEST/search-index] The phrase *"risk limits are hard limits"* appears to be consulting/folklore shorthand rather than regulatory or bank language. **The operative primary language is "valid limit breach," "hard limit" as a *type* of pre-trade limit (FIA/RTS 6, below), and "the business takes immediate steps to reduce exposure."**

---

## 6.4 Drawdown-based de-risking — and whether it works

### Managed-futures / systematic practice
- The **Turtles** de-risked on a schedule: 20% notional reduction per 10% drawdown (see §6.2). [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)
- Rob Carver (systematic trader, ex-AHL, author of *Systematic Trading*) describes the general practice precisely: *"Note that this degearing will be in addition to the normal derisking you should always do when you lose money; if you lose 10% then you should derisk your system by 10% regardless of whether you are using an equity curve trading overlay."* He lists the two common triggers: *"if your drawdown exceeds 10% then you might take action"* (absolute drawdown) or *"if your account curve falls below the moving average, then you take action"* (moving-average filter). [PRIMARY — named practitioner's own blog](https://qoppac.blogspot.com/2015/11/random-data-evaluating-trading-equity.html)

**Important distinction:** *constant-percentage risk* (de-risk proportionally as equity falls — which is arithmetically automatic if you size off current equity) is different from *discretionary or rules-based de-risking after a drawdown threshold*. The Turtles' rule is the latter; Carver's "normal derisking" is the former.

### The research: de-risking after drawdowns is NOT reliably helpful
**Kaminski & Lo, "When Do Stop-Loss Rules Stop Losses?"** (SIFR Research Report No. 63, 2008) [PRIMARY — academic working paper, abstract fetched](https://swopec.hhs.se/sifrwp/abs/sifrwp0063.htm). Verbatim from the abstract:

> *"Stop-loss rules—predetermined policies that reduce a portfolio's exposure after reaching a certain threshold of cumulative losses—are commonly used by retail and institutional investors to manage the risks of their investments, but have also been viewed with some skepticism by critics who question their efficacy."*
>
> *"We show that **under the Random Walk Hypothesis, simple 0/1 stop-loss rules always decrease a strategy's expected return**, but in the presence of momentum, stop-loss rules can add value."*
>
> *"Using monthly returns data from January 1950 to December 2004, we find that certain stop-loss rules add **50 to 100 basis points per month** to the buy-and-hold portfolio during stop-out periods."*

**Carver's random-data test of "trading the equity curve"** [PRIMARY — named practitioner, full methodology + code published](https://qoppac.blogspot.com/2015/11/random-data-evaluating-trading-equity.html):
- Method: generate large numbers of random equity curves with controlled Sharpe, skew and autocorrelation; apply a moving-average overlay (system off when equity < N-day MA); measure return, average drawdown, max drawdown, return/drawdown. N tested = 10, 25, 40, 64, 128, 256, 512 business days.
- *"for all profitable equity curves equity curve trading reduces, rather than increases, your returns."*
- *"for profitable systems there is no benefit, and average drawdowns may even be slightly worse."*
- *"For a profitable system applying an equity curve overlay reduces the average return / max drawdown ratio; with faster overlays (small N) probably worse (and they would be much, much worse with trading costs applied)."*
- The one condition where it helps: **positive autocorrelation**. *"If you have negative or zero autocorrelation then adding an equity curve overlay will make your returns much worse. But if you have positive autocorrelation it will improve them."* And: *"if your strategy is a trend following strategy, then it probably has negative autocorrelation, and applying the filter will be an unmitigated disaster."*
- After adding costs: *"I'd suggest that at this cost level you need a positive autocorrelation of at least 0.2 before even considering trading the equity curve."*
- *"The idea that you can easily improve a profitable equity curve by adding a simple moving average filter is, probably, wrong."*

**The counter-caveat, from the same author:** in comments, Carver concedes the tail-risk rationale — *"I guess a system where you cut after the drawdown reached X% might protect you from a drawdown larger than you ever saw in simulation; i.e. the situation when the MR relationship breaks down."* [PRIMARY](https://qoppac.blogspot.com/2015/11/random-data-evaluating-trading-equity.html)

**Synthesis for the brief:** the evidence says drawdown-triggered de-risking is a *cost*, not a free improvement, for profitable mean-reverting or trend-following systems — but it buys protection against drawdowns larger than the backtest, which is exactly why institutions (Turtles, banks, prop firms) mandate it anyway. It is an insurance premium, and it should be priced as one.

---

## 6.5 Circuit breakers and kill switches

### Exchange-level, US equities — the actual numbers

**Market-Wide Circuit Breakers (MWCB).** From the SEC's own investor-education page [PRIMARY — SEC / investor.gov](https://www.investor.gov/introduction-investing/investing-basics/glossary/stock-market-circuit-breakers), quoted:
> *"A cross-market trading halt can be triggered at three circuit breaker thresholds—**7% (Level 1), 13% (Level 2), and 20% (Level 3)**. These triggers are set by the markets at point levels that are calculated daily based on the prior day's closing price of the S&P 500 Index."*
>
> *"A market decline that triggers a Level 1 or Level 2 circuit breaker **before 3:25 p.m. will halt market-wide trading for 15 minutes**, while a similar market decline **'at or after' 3:25 p.m. will not halt** market-wide trading. A market decline that triggers a **Level 3** circuit breaker, at any time during the trading day, will **halt market-wide trading for the remainder of the trading day**."*

**Limit Up–Limit Down (LULD) — the single-stock circuit breaker.** Quoted from the same SEC page:
> *"it prevents trades in individual securities from occurring outside of a specified price band. This price band is set at a percentage level above and below the average price of the stock over the immediately preceding **five-minute** trading period. If the stock's price moves to the price band and does not move back within the price bands **within 15 seconds, trading in the stock will pause for five minutes**. These price bands are **5%, 10%, 20%, or the lesser of $.15 or 75%**, depending on the price of the stock and whether the stock is designated as a **Tier 1 or Tier 2** NMS stock."*
>
> *"The LULD's **price bands double during the last 25 minutes** of the regular trading day for (i) all Tier 1 NMS stocks and (ii) Tier 2 NMS stocks at or below $3.00."*

The full band table is published by broker-dealers as a compliance disclosure; a representative version [PRIMARY — broker-dealer LULD disclosure, Opco](https://www.opco.com/pdf/disclosure/15-bro-45-limit-up-limit-down-09-22-15.pdf) gives:

| Security | Time | Price Band |
|---|---|---|
| **Tier 1** stocks > $3.00 | 09:45–15:35 | **5%** |
| **Tier 2** stocks > $3.00 | 09:45–15:35 | **10%** |
| Tier 1 & 2 stocks $0.75–$3.00 | 09:45–15:35 | **20%** |
| Tier 1 & 2 stocks < $0.75 | 09:45–15:35 | lesser of **$0.15 or 75%** |
| Tier 1 stocks > $3.00 | 09:30–09:45 and 15:35–16:00 | **10%** (doubled) |
| Tier 2 stocks > $3.00 | 09:30–09:45 and 15:35–16:00 | **20%** (doubled) |
| Tier 1 & 2 stocks $0.75–$3.00 | 09:30–09:45 and 15:35–16:00 | **40%** (doubled) |
| Tier 1 & 2 stocks < $0.75 | 09:30–09:45 and 15:35–16:00 | lesser of **$0.30 or 150%** |

Tier 1 = *"Those stocks in the S&P 500, Russell Index, and certain Exchange Traded Funds ('ETFs')"*; Tier 2 = *"other listed securities"*. [PRIMARY — Opco LULD disclosure](https://www.opco.com/pdf/disclosure/15-bro-45-limit-up-limit-down-09-22-15.pdf)

**NYSE Rule 80B** is the securities-market rule the futures rules cross-reference. The SEC's page describes the same 7/13/20 thresholds. A CME rule filing with the CFTC states the cross-market linkage explicitly: *"If a **NYSE Rule 80B trading halt** is declared in the primary securities market as the result of a Level 1 (7%), Level 2 (13%) or Level 3 (20%) decline in the S&P 500 Index, then trading in Euro denominated E-mini S&P 500 Index futures contracts shall be halted. When trading in the primary securities market resumes after a NYSE Rule 80B trading halt, trading on the E-mini S&P 500 Index futures contract shall resume."* [PRIMARY — CME rule filing with the CFTC (PDF)](https://www.cftc.gov/sites/default/files/filings/ptc/14/10/ptc102314cmedcm033.pdf) Note the NYSE's own PDF of Rule 80B could not be retrieved (HTTP 404 at the URL tried).

### Exchange-level, futures (CME)

From CME's own contract rule terms as filed with the CFTC [PRIMARY — CME rule filing, CFTC (PDF)](https://www.cftc.gov/sites/default/files/filings/ptc/14/10/ptc102314cmedcm033.pdf), and a second filing [PRIMARY — CME rule filing, CFTC (PDF)](https://www.cftc.gov/sites/default/files/filings/ptc/15/09/ptc090315cmedcm004.pdf):
- **Offsets are computed mechanically off the S&P 500 index value ("I") taken ten minutes after the close of the primary securities market:**
  - *"5% Offset Equals 5% of I, or (0.05 x I) rounded down to the nearest 0.50 point increment"*
  - *"7% Offset Equals 7% of I or (0.07 × I) rounded down to the nearest 0.50 point increment"*
  - *"13% Offset Equals 13% of I or (0.13 × I), rounded down to the nearest 0.50 point increment"*
  - *"20% Offset Equals 20% of I or (0.20 × I), rounded down to the nearest 0.50 point increment"*
- **Trading-day structure of the limits (second filing):** *"Interval Price Limits: **5:00pm to 8:30am — 5% above Fixing Price to 5% below Fixing Price**; **8:30am to 3:00pm — Sequential circuit breaker limits at 7%, 13%, and 20% below Fixing Price**; **3:00pm to 4:15pm — 5% above Fixing Price to 5% below Fixing Price**, provided there is no breach of current day's circuit breaker limit of 20% below Fixing Price."*
- **Position limits are also numeric:** for the Russell Index contract example, *"Position Reportability: 100+ contracts; **All-Month Position Limit (Net Futures Contract Equivalents): 28,000 contracts**; Minimum Block Trade Threshold Level 50 contracts."* [PRIMARY — CME filing, CFTC](https://www.cftc.gov/sites/default/files/filings/ptc/15/09/ptc090315cmedcm004.pdf)
- *"At or after 2:25 p.m., the Level 1 (7%) and Level 2 (13%) trading halts in the primary securities market are not applicable. Following the declaration of a Level 3 (20%) trading halt in the primary securities market, there shall be no trading… until trading resumes on the primary securities market on the next Trading Day."* [PRIMARY](https://www.cftc.gov/sites/default/files/filings/ptc/14/10/ptc102314cmedcm033.pdf) (Note the 2:25 p.m. CT equivalent of the 3:25 p.m. ET rule.)

**Assessment:** every one of these is a *pre-computed, automatically-triggered, non-discretionary* gate. The only human input is the exchange's daily determination of the reference price. Note also that the LULD band is a **rolling 5-minute average price ± band**, checked by the *matching engine*, and the escalation from "limit state" to "trading pause" is a **15-second timer** — a machine watching a clock, not a person watching a screen.

### Firm-level kill switches and what happens without them

**The canonical failure case: Knight Capital, 1 August 2012.** The SEC's administrative findings, as reported [SECONDARY — City AM reporting the SEC order and its findings](https://www.cityam.com/knight-capital-fined-12m-over-trading-mistake/):
- *"a software problem at Knight caused **four million unintentional orders to flood into the market over a 45-minute period, when attempting to fill just 212 customer orders**, the SEC said. Knight traded **more than 397m shares** and ended up with **'several billion dollars' in unwanted positions, which it had to unload at a loss of over $460m**."*
- *"Knight did not have appropriate risk controls in place to prevent the execution of erroneous trades or orders that exceed pre-set credit or capital thresholds, violating the SEC's Market Access Rule, the regulator said."*
- *"Knight had also failed to conduct adequate reviews of the effectiveness of its controls, the SEC said."*
- Knight was fined **$12m**, and *"neither admitted nor denied the SEC's findings."*
- Direct quote from the SEC's then-chief of the market abuse unit, Daniel Hawke: *"These numbers highlight the risks that arise from automated trading, and the immense consequences that errors can have both for the firm itself, and for the market in general."*
- Consequence for the firm: *"The trading error forced Jersey City, New Jersey-based Knight to seek investors to help it stay afloat. The firm was later bought by Chicago-based Getco Holding for $1.4bn."*

The SEC's own press release and administrative order PDFs are at [sec.gov/newsroom/press-releases/2013-222](https://www.sec.gov/newsroom/press-releases/2013-222) and [sec.gov/litigation/admin/2013/34-70694.pdf](https://www.sec.gov/litigation/admin/2013/34-70694.pdf) — **both returned HTTP 403 to automated fetches during this research**; the City AM report of the same findings is used instead and is flagged [SECONDARY].

**The kill switch as a required control.** MiFID II RTS 6 Article 12 makes kill functionality legally mandatory for EU investment firms (*"cancel immediately, as an emergency measure, any or all of its unexecuted orders"*), and the FIA PTG recommends a *"manual 'kill button' that, when activated, disables the system's ability to trade and cancels all resting orders"* — plus a **repeated-execution throttle** that *"should be disabled until a human re-enables it"* after a *"configurable number of repeated executions."* [PRIMARY — RTS 6](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589); [PRIMARY — FIA PTG](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf)

Knight's failure is precisely the control these documents demand: no effective pre-trade credit/capital threshold rejection (the 15c3-5 requirement), and no functioning kill switch deployed during a 45-minute window. [SECONDARY — City AM](https://www.cityam.com/knight-capital-fined-12m-over-trading-mistake/)

---

## 6.6 Regulatory / industry pre-trade risk control standards

### SEC Rule 15c3-5 — the Market Access Rule [PRIMARY — codified rule text]

Full text fetched from the Legal Information Institute's e-CFR mirror [PRIMARY — 17 CFR § 240.15c3-5](https://www.law.cornell.edu/cfr/text/17/240.15c3-5). (Note: sec.gov returned HTTP 403 to automated fetches; the Cornell LII mirror of the same CFR text is used instead. The rule is also at [75 FR 69825](https://www.law.cornell.edu/cfr/text/17/240.15c3-5).)

The rule requires brokers/dealers with market access to *"establish, document, and maintain a system of risk management controls and supervisory procedures reasonably designed to manage the financial, regulatory, and other risks of this business activity."*

**Financial risk management controls — the actual requirements, quoted:**
> *"(i) Prevent the entry of orders that exceed appropriate pre-set credit or capital thresholds in the aggregate for each customer and the broker or dealer and, where appropriate, more finely-tuned by sector, security, or otherwise by rejecting orders if such orders would exceed the applicable credit or capital thresholds; and"*
>
> *"(ii) Prevent the entry of erroneous orders, by rejecting orders that exceed appropriate price or size parameters, on an order-by-order basis or over a short period of time, or that indicate duplicative orders."*

**Regulatory risk management controls, quoted:**
> *"(i) Prevent the entry of orders unless there has been compliance with all regulatory requirements that must be satisfied on a pre-order entry basis; (ii) Prevent the entry of orders for securities for a broker or dealer, customer, or other person if such person is restricted from trading those securities; (iii) Restrict access to trading systems and technology that provide market access to persons and accounts pre-approved and authorized by the broker or dealer; and (iv) Assure that appropriate surveillance personnel receive immediate post-trade execution reports that result from market access."*

**The crucial "mechanical, not discretionary" provision — direct and exclusive control:**
> *"(d) The financial and regulatory risk management controls and supervisory procedures described in paragraph (c) of this section shall be **under the direct and exclusive control of the broker or dealer** that is subject to paragraph (b) of this section."*

Even where control is contractually allocated to a customer that is itself a broker-dealer, *"Any allocation of control pursuant to paragraph (d)(1)… shall not relieve a broker or dealer… from any obligation under this section, including the overall responsibility to establish, document, and maintain a system of risk management controls."* [PRIMARY](https://www.law.cornell.edu/cfr/text/17/240.15c3-5)

**Ongoing obligation and CEO certification:**
> *"(e)… the broker or dealer shall review, **no less frequently than annually**, the business activity of the broker or dealer in connection with market access to assure the overall effectiveness of such risk management controls and supervisory procedures. Such review shall be conducted in accordance with written procedures and shall be documented."*
>
> *"(2) The Chief Executive Officer (or equivalent officer)… shall, **on an annual basis, certify** that such risk management controls and supervisory procedures comply with paragraphs (b) and (c) of this section…"*

Source: [PRIMARY — 17 CFR § 240.15c3-5](https://www.law.cornell.edu/cfr/text/17/240.15c3-5), promulgated at 75 FR 69825, Nov. 15, 2010.

**FINRA guidance:** FINRA's own rule pages (Rule 3110, Regulatory Notice 11-03) returned HTTP 403 to automated fetches and could not be retrieved directly. See "What I could not find."

### FIA Principal Traders Group — "Recommendations for Risk Controls for Trading Firms" (November 2010) [PRIMARY — industry body's own document]

Full PDF fetched and text-extracted from [FIA PTG, Recommendations for Risk Controls for Trading Firms (PDF)](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf). This is a principal-traders' (proprietary trading firms') own best-practice document, written in response to regulators looking at direct market access.

**Pre-trade risk limits — "hard limits", automatically enforced:**
> *"Trading firms should establish and **automatically enforce** pre-trade risk limits that are appropriate for the firms' capital base, clearing arrangements, trading style, experience, and risk tolerance. These risk limits can include a variety of **hard limits**, such as position size and order size. Depending on the trading strategy, these limits may be set at several levels of aggregation. These risk limits should be implemented in **multiple independent pre-trade components** of a trading system."*

**Price collars:**
> *"Trading systems should have upper and lower limits on the price of the orders they can send, configurable by product. They should **prevent any order for a price outside of the 'price collar' from leaving the system**."*

**Fat-finger quantity limits:**
> *"Trading systems should have upper limits on the size of the orders they can send, configurable by product. They should **prevent any order for a quantity larger than the fat-finger limit from leaving the system**."*

**Repeated automated execution throttle:**
> *"Automated trading systems should have functionality in place that monitors the number of times a strategy is filled and then re-enters the market without human intervention. After a configurable number of repeated executions **the system should be disabled until a human re-enables it**."*

**Outbound message rate:** *"Trading firms should limit the number of order messages their trading systems can send to the exchange in a short period of time."*

**Volatility awareness — an alert/pause/disable tri-state:**
> *"Trading systems should take a specified action (have an alert, pause, or automatically disable) if an unusual price move or volume spike occurs during a specified timeframe."*

**Kill button:**
> *"Trading systems should have a manual 'kill button' that, when activated, **disables the system's ability to trade and cancels all resting orders**."*

**Post-trade limits — daily loss limits with automated close-out:**
> *"Trading firms can also establish and **automatically enforce** post-trade risk limits… For example, a trading firm can set **daily loss-limits by instrument, asset class, and strategy and automatically close out or reduce positions if those limits are breached**."*

**Risk managers monitoring independently of the trading system — the separation-of-duties point:**
> *"The drop-copy data may also be used by **risk managers to view their firm's risk exposure independently of the trading system**."*
>
> *"firms should consider **segregating trading and back office roles and responsibilities in such a way that an individual cannot conceal unauthorized trading activity**."*

**Supervision, authorisation and control of the limits themselves:**
> *"Firms should have policies and processes for setting, modifying and tracking changes to pre- and post-trade risk checks. Policies should specify **who is authorized to enter, view and modify pre- and post-trade checks, which checks are enforced, and in what manner**."*
>
> *"Each ETS should have a **management console** to display information about the actions and market exposure. This management console should also provide the trader with the capability to control the ETS."*

**Heartbeats / cancel-on-disconnect:** *"Electronic trading systems should monitor 'heartbeats'… If connectivity is lost, the ETS should be disabled and working orders cancelled by the system or through exchange-provided 'cancel-on-disconnect' functionality."*

All of the above: [PRIMARY — FIA PTG PDF](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf)

### MiFID II / MiFIR RTS 6 — Commission Delegated Regulation (EU) 2017/589 [PRIMARY — the legal text]

Full text fetched from EUR-Lex: [Commission Delegated Regulation (EU) 2017/589 (RTS 6)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589).

**Article 13 — "Pre-trade controls on order entry".** *"An investment firm shall carry out the following pre-trade controls on order entry for all financial instruments:"*
> *"(a) **price collars**, which **automatically block or cancel** orders that do not meet set price parameters, differentiating between different financial instruments, both on an order-by-order basis and over a specified period of time;"*
> *"(b) **maximum order values**, which prevent orders with an uncommonly large order value from entering the order book;"*
> *"(c) **maximum order volumes**, which prevent orders with an uncommonly large order size from entering the order book;"*
> *"(d) **maximum messages limits**, which prevent sending an excessive number of messages to order books pertaining to the submission, modification or cancellation of an order."*

> *"2. An investment firm shall immediately include all orders sent to a trading venue into the calculation of the pre-trade limits referred to in paragraph 1."*
>
> *"3. An investment firm shall have in place **repeated automated execution throttles** which control the number of times an algorithmic trading strategy has been applied. After a pre-determined number of repeated executions, **the trading system shall be automatically disabled until re-enabled by a designated staff member**."*
>
> *"4. An investment firm shall set market and credit risk limits that are based on its capital base, its clearing arrangements, its trading strategy, its risk tolerance, experience and certain variables, such as the length of time the investment firm has been engaged in algorithmic trading and its reliance on third-party vendors."*
>
> *"5. An investment firm shall **automatically block or cancel orders** from a trader if it becomes aware that that trader does not have permission to trade a particular financial instrument. An investment firm shall automatically block or cancel orders where those orders risk compromising the investment firm's own risk thresholds. Controls shall be applied, where appropriate, on exposures to individual clients, financial instruments, traders, trading desks or the investment firm as a whole."*
>
> *"6. An investment firm shall have procedures and arrangements in place for dealing with orders which have been blocked by the investment firm's pre-trade controls but which the investment firm nevertheless wishes to submit. Such procedures and arrangements shall be applied in relation to a specific trade **on a temporary basis and in exceptional circumstances**. They shall be subject to **verification by the risk management function and authorisation by a designated individual** of the investment firm."*

**Article 12 — "Kill functionality":**
> *"1. An investment firm shall be able to **cancel immediately, as an emergency measure, any or all of its unexecuted orders** submitted to any or all trading venues to which the investment firm is connected ('kill functionality')."*
> *"2. …unexecuted orders shall include those originating from individual traders, trading desks or, where applicable, clients."*
> *"3. …an investment firm shall be able to identify which trading algorithm and which trader, trading desk or, where applicable, which client is responsible for each order."*

**Article 16 — "Real-time monitoring", including the independence requirement and a hard latency number:**
> *"2. The real-time monitoring of algorithmic trading activity shall be undertaken by the trader in charge of the trading algorithm or algorithmic trading strategy, **and by the risk management function or by an independent risk control function**… That risk control function shall be considered to be independent… **provided that that function is not hierarchically dependent on the trader and can challenge the trader as appropriate**…"*
>
> *"5. The systems for real-time monitoring shall have **real-time alerts** to assist staff in identifying unanticipated trading activities… Those systems shall also provide alerts in relation to algorithms and DEA orders triggering circuit breakers of a trading venue. **Real-time alerts shall be generated within five seconds after the relevant event.**"*

**Article 17 — "Post-trade controls":**
> *"1. An investment firm shall **continuously operate** the post-trade controls that it has in place. Where a post-trade control is triggered, the investment firm shall undertake appropriate action, which may include **adjusting or shutting down the relevant trading algorithm or trading system or an orderly withdrawal from the market**."*
> *"4. For derivatives, the post-trade controls… shall include controls regarding the **maximum long and short and overall strategy positions**, with trading limits to be set in units that are appropriate to the types of financial instruments involved."*

**Article 9 — Annual self-assessment and validation:** *"An investment firm shall **annually** perform a self-assessment and validation process and on the basis of that process issue a validation report."* The self-assessment must include *"an analysis of compliance with the criteria set out in Annex I"*. [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

**Article 10 — stress testing:** *"As part of its annual self-assessment referred to in Article 9, an investment firm shall test that its algorithmic trading systems and the procedures and controls referred to in Articles 12 to 18 can withstand increased order flows or market stresses."* [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

**Article 13 recital, on the *purpose* of alerts** (useful for Q8): recital 35 states that *"An investment firm should also **monitor its trading activity and implement real-time alerts which identify signs of disorderly trading or a breach of its pre-trade limits**… potential market abuse and violations of the rules of the trading venue should be prevented through specific surveillance systems that **generate alerts on the following day at the latest and that are calibrated to minimise false positive and false negative alerts**."* [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589) — note the regulation *explicitly* requires false-positive calibration. That is the regulatory hook for alert tuning.

**DEA providers (Article 20):** *"the orders of a DEA client shall always pass through the pre-trade controls that are set and controlled by the DEA provider"* and *"the DEA provider shall also ensure that it is **solely entitled to set or modify the parameters or limits** of those pre-trade and post-trade controls and real time monitoring."* [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

**Clearing firms (Article 23):** clearing firms must *"monitor its clearing clients' positions against the limits referred to in paragraph 1 **as close to real-time as possible** and have appropriate pre-trade and post-trade procedures for managing the risk of breaches of the position limits, by way of appropriate margining practice and other appropriate means."* [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

---

## 6.7 Crypto-specific

**Overall finding: crypto exchange risk engines are the most purely mechanical risk gates found anywhere in this research — more so than prop firms or banks. There is no escalation path, no limit-approver, and no human in the loop.** The limits are published as numbers, the engine acts, and the user agreement places the outcome entirely on the trader.

### OKX — tiered maintenance margin, partial liquidation, liquidation engine [PRIMARY — exchange's own help documentation]

From OKX's own documentation of its "leverage gradient MMR system" [PRIMARY — OKX Help Center](https://www.okx.com/help/what-is-the-leverage-gradient-maintenance-margin-system):

- *"The tiered maintenance margin system applies different maintenance margin requirements based on your position size. As your position increases and moves into a higher tier: The required maintenance margin rate (MMR) increases. The maximum available leverage decreases."*
- **Two hard thresholds, both mechanical:**
  - *"When the maintenance margin ratio of your position is **≤300%**, the system will issue a warning to reduce your position… The 300% is a warning parameter."*
  - *"When the maintenance margin ratio of your position is **≤100%, it will trigger a forced liquidation**, removing your open orders in opposite directions. Some or all of your position with isolated margin will be transferred to the liquidation engine."*
- **Partial de-risking by tier is automatic** — a genuine mechanical "reduce size" ladder: *"when you hold a larger position… and your position tier is at 2 or higher… the liquidation engine won't immediately liquidate your entire position if it detects that the current maintenance margin ratio is below 100%. Instead, it'll perform a **forced partial reduction**. First, it calculates the quantity to reduce in order to lower the current position by one tier: current borrowed quantity − maximum borrowable quantity at tier 2 = 110 − 100 = 10."*
- **Then full liquidation at the bankruptcy price:** *"When your position is at tier 1 and the maintenance margin ratio is below 100%… the system will directly order all contracts of that position to the **liquidation engine at the bankruptcy price (the price that wipes out all margin)**."*
- Worked example given by OKX: MMR = (liability + interest) × tier MMR × mark price; for 110 BTC at 4.00% MMR and mark price 19,500 → *"MMR = (110 + 0.5) * 4.00% * 19500 = 86190 USDT"*. Moving the mark price from 19,500 to 29,000 takes the maintenance margin ratio from **1325.07% to 74.16%**, which triggers reduction.
- **Where the money goes:** *"At each stage, the reduction in position is handed over to the liquidation engine at the current mark price, and the corresponding MMR for the reduced quantity is collected… The remaining amount will be injected into the platform's **risk reserve**."*
- **The engine cancels orders before liquidating:** *"it will cancel all unfilled orders for the current cryptocurrency in the cross margin (including strategy orders)… If, after the cancellations, the maintenance margin ratio remains at 100% or below, the account will trigger a forced liquidation."*

Note the deliberate **soft tier (300%, warning only) / hard tier (100%, forced liquidation)** structure — structurally identical to JPMorgan's Risk Appetite early indicators versus valid limit breaches (§6.3).

### Auto-deleveraging (ADL) — the exchange's ultimate backstop

ADL is the mechanism by which, when the liquidation engine cannot close a bankrupt position in the market, **profitable traders on the other side have their positions forcibly closed** to absorb the loss. Binance publishes this mechanism in its Help Center [PRIMARY — Binance's own FAQ, "What Is Auto-Deleveraging (ADL) and How Does It Work?"](https://www.binance.com/en-ZA/support/faq/detail/360033525471) and in its [Binance Futures Services Agreement](https://www.binance.com/en/binance-futures-services-agreement).

**Honesty flag:** Binance's help-centre pages returned **HTTP 202 with an empty body** to every automated fetch attempted during this research (bot challenge), from four different Binance domains and two URL variants, and `web_fetch` also returned an empty document. **I therefore could not read Binance's ADL documentation directly.** The URL above is the canonical location, and the mechanism is described in Binance's own search-result snippets, but I have **not** verified Binance's specific ranking formula (profit ratio, effective leverage, and the "ADL indicator" light sequence) from a fetched primary source. Treat any specific Binance ADL formula as **[UNVERIFIED]** here. This is a genuine gap, listed in "What I could not find".

The mechanism as an industry pattern is nonetheless well documented: when a position cannot be liquidated at a price better than the bankruptcy price, the exchange's risk engine selects counterparties — ranked by profitability and leverage — and closes their positions at the bankruptcy price, without their consent. That is the purest possible statement of the brief's thesis: at the extreme, a professional's position is closed by a machine they do not control, on a schedule they did not choose. [PRIMARY — OKX's documentation describes the same liquidation-engine-at-bankruptcy-price step](https://www.okx.com/help/what-is-the-leverage-gradient-maintenance-margin-system); [SECONDARY — third-party explainer on ADL and insurance funds in perpetuals](https://crypto-resources.com/adl-auto-deleveraging-insurance-fund/)

### Crypto prop firms

**Not covered by primary research here.** Crypto-native prop firms (Funding Pips, The Funded Trader, Breakout Prop, HyroTrader and similar) were not researched to primary-source standard within this brief. The general pattern — crypto prop firms running the same daily-loss / max-drawdown / profit-target architecture as FTMO, enforced by the platform rather than by the trader — is asserted widely across affiliate and review sites that carry strong SEO incentives and often stale rules. **Treat all crypto-prop-firm rule numbers found online as [FOLKLORE] unless taken from the firm's own live rules page.** This is listed in "What I could not find".

### Crypto exchange price bands / circuit breakers

Not verified from primary exchange documentation in this research (Binance's "limit down / limit up" futures price-band rules live behind the same bot challenge that blocked the ADL pages). CME's Bitcoin futures position limits are set in CME rule filings and would be the most reliable primary comparator; the CME/CFTC filing route used in §6.5 is the method to follow. **[UNVERIFIED]**

---

## 6.8 Who enforces — the synthesis

Across the four populations, the answer to "who enforces" is consistently **not the trader**:

| Population | Limit set by | Enforced by | Evidence |
|---|---|---|---|
| Prop firm (Topstep) | Firm | Automated real-time liquidation engine on unrealized P&L | [PRIMARY](https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit) |
| Prop firm (FTMO) | Firm | Platform-level equity monitoring; breach = rule violation; forbidden-practice review by firm | [PRIMARY](https://ftmo.com/en/trading-objectives/) |
| Turtle program | Dennis/Eckhardt | Written notional-account step-down rule; trader self-applies but the rule is fixed ex ante | [PRIMARY](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf) |
| Bank | Market Risk Management | Market Risk Management decides remedy; breaches escalate to limit approvers | [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm) |
| US broker-dealer | Firm (exclusively) | Automated pre-trade rejection; CEO annual certification | [PRIMARY](https://www.law.cornell.edu/cfr/text/17/240.15c3-5) |
| EU investment firm | Firm, limits set by risk function | Automatic block/cancel; kill functionality; independent risk function that "can challenge the trader" | [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589) |
| Prop trading firm (FIA PTG members) | Firm | "automatically enforce" pre- and post-trade limits; disable until human re-enables | [PRIMARY](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf) |

Three recurring design principles:
1. **The limit is numeric and pre-set** — never "the trader will use judgement."
2. **The gate is automated and rejects/blocks/closes** — "prevent… from leaving the system", "automatically block or cancel", "liquidated immediately".
3. **Override is an escalation, not a right** — the trader must go to the risk function, on a temporary and exceptional basis, and it is verified/authorised by someone other than the trader. FTMO: *"these rules are mandatory and is your main responsibility"*; JPM: *"Market Risk Management… determine[s] the suitable course of action"*; RTS 6 Art. 13(6): *"subject to verification by the risk management function and authorisation by a designated individual."*

---

# Q8. MONITORING AND ALERTING IN PRACTICE

## 8.1 The strongest single statement: professionals are explicitly told not to watch screens

The best primary source for "alert-driven, not screen-driven" is **Google's SRE Book**, which states the design principle outright:

> *"while it can be fun to have access to traffic graph dashboards and the like, SRE teams **carefully avoid any situation that requires someone to 'stare at a screen to watch for problems.'**"*

[PRIMARY — Google, *Site Reliability Engineering*, Ch. 6 "Monitoring Distributed Systems", written by Rob Ewaschuk](https://sre.google/sre-book/monitoring-distributed-systems/) (CC BY-NC-ND 4.0)

The same chapter gives the operating doctrine for what deserves a human's attention:

> *"Paging a human is a quite expensive use of an employee's time. If an employee is at work, a page interrupts their workflow. If the employee is at home, a page interrupts their personal time, and perhaps even their sleep. **When pages occur too frequently, employees second-guess, skim, or even ignore incoming alerts, sometimes even ignoring a 'real' page that's masked by the noise.** Outages can be prolonged because other noise interferes with a rapid diagnosis and fix. Effective alerting systems have good signal and very low noise."*

> *"Every time the pager goes off, I should be able to react with a sense of urgency. **I can only react with a sense of urgency a few times a day before I become fatigued.** Every page should be actionable. Every page response should require intelligence. If a page merely merits a robotic response, it shouldn't be a page. **Pages should be about a novel problem or an event that hasn't been seen before.**"*

> *"you should **never trigger an alert simply because 'something seems a bit weird.'**"*

The chapter's own checklist for a new alert — directly transferable to a trading-desk alerting spec:
- *"Does this rule detect an otherwise undetected condition that is urgent, actionable, and actively or imminently user-visible?"*
- *"Will I ever be able to ignore this alert, knowing it's benign?"*
- *"Does this alert definitely indicate that users are being negatively affected?"*
- *"Can I take action in response to this alert? Is that action urgent, or could it wait until morning? Could the action be safely automated?"*
- *"Are other people getting paged for this issue, therefore rendering at least one of the pages unnecessary?"*

[PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

And a directly relevant footnote: Google's alerting guidance cites *"Applying **Cardiac Alarm Management Techniques** to Your On-Call"* as *"an example of alert fatigue in another context"* — i.e. the SRE community explicitly imported the medical alarm-fatigue literature into operations. [PRIMARY — footnote 24](https://sre.google/sre-book/monitoring-distributed-systems/)

**The Bigtable over-alerting post-mortem** (same chapter) is the canonical case study of what happens when you don't: paging alerts *"were firing voluminously, consuming unacceptable amounts of engineering time: the team spent significant amounts of time triaging the alerts to find the few that were really actionable, and we often missed the problems that actually affected users, because so few of them did."* The remedy was to **reduce alert volume deliberately** — dial the SLO back to the 75th percentile and **disable email alerts entirely** — to create room to fix the underlying problem. [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

## 8.2 Exception-based monitoring / "management by exception"

The concept predates trading: **management by exception (MBE)** is the principle that a manager should attend only to significant deviations from plan, and leave conforming performance alone. It is standard managerial-accounting / management-theory doctrine, taught in university management and cost-accounting curricula (e.g. [SECONDARY — Lumen Learning, *Responsibility Reports*, on management by exception in responsibility accounting](https://courses.lumenlearning.com/suny-managacct/chapter/responsibility-reports/); [SECONDARY — university course material on MBE as a project-management technique](https://www.du.ac.in/uploads/new-web/29122022_Appendix-121.pdf)).

The **trading/risk translation** is direct: instead of a human continuously reading levels, you pre-commit thresholds and let a machine tell you when one is crossed. The regulatory articulation of this in trading is RTS 6 Article 16(5) (real-time alerts to *"assist staff in identifying unanticipated trading activities"*, generated *"within five seconds"*) and Article 13's automatic block/cancel controls. [PRIMARY — RTS 6](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589) FIA PTG's recommendation that *"Trading systems should take a specified action (**have an alert, pause, or automatically disable**) if an unusual price move or volume spike occurs during a specified timeframe"* is exception-based monitoring written as a control. [PRIMARY — FIA PTG](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf)

**The bank version:** JPMorgan's risk reporting is described as *"daily notification of limit utilizations and limit breaches"* and *"Limit utilizations and notifications of valid market risk limit breaches are sent to appropriate"* recipients — i.e. the risk function pushes exceptions daily rather than watching continuously. [PRIMARY — JPMorgan 2024 Annual Report](https://www.jpmorgan.com/content/dam/jpm/global/disclosures/de/english-version-of-disclosures/2024-annual-report-english.pdf)

## 8.3 Deliberate screen-time limits — Steenbarger and the "market myopia" argument

Brett Steenbarger (Ph.D.; performance coach to portfolio managers and traders at financial organisations; author of *The Psychology of Trading*) has written two posts that are directly on point and are the practitioner-side complement to the SRE doctrine above.

**"Market Myopia" (TraderFeed, 8 Dec 2007)** [PRIMARY — named practitioner's own blog](http://traderfeed.blogspot.com/2007/12/market-myopia.html):
> *"Does watching the market tick-by-tick improve your trading returns? …If, however, you're trading over time frames lasting an hour or more, does it add value to be glued to the screen? Does watching each tick lead to better trading decisions or returns, or does it lead to a kind of **myopia in which we become reactive and no longer follow our original trading ideas**?"*
>
> *"My sense is that watching markets tick-by-tick often stems from **an illusion of control**: that, by monitoring events tightly, we can somehow better control them. Research suggests, however, that **getting more feedback about investments leads to risk aversion and reduced returns**. This myopia stems from the fact that we tend to perceive meaningful patterns in events even when those aren't present. When we watch markets tick-by-tick, we begin to see patterns that we believe are indicative of shifting supply and demand. This perception leads us to **exit positions before they've reached their target or delay entering positions that otherwise offer favorable reward:risk**."*
>
> *"I also get the sense that some traders **equate working hard with being glued to screens**. In reality, the hard work of trading lies in what comes prior to putting the trade on: the research and analysis that pull together observations across markets and time frames to generate valid ideas. To the extent that tracking markets tick-by-tick is an expression of anxiety over one's position, it is **not only not productive… but is actively destructive** (keeping oneself in a mindset that is harmful to sound decision-making)."*
>
> *"By cutting winners short and delaying entries into good ideas, the trader glued to the screen reduces the risk:reward potential of each trade. Perhaps that is why frustrated traders who are 'working hard' find that their trades are hardly working."*

The research Steenbarger links is the QJE paper: **Thaler, Tversky, Kahneman & Schwartz (1997), "The Effect of Myopia and Loss Aversion on Risk Taking: An Experimental Test," *Quarterly Journal of Economics* 112(2), p. 647** — the experimental result that more frequent feedback about an investment makes subjects more risk-averse and produces worse outcomes. [PRIMARY — the cited paper's record](https://katalog.slub-dresden.de/en/id/ai-55-aHR0cHM6Ly93d3cuanN0b3Iub3JnL3N0YWJsZS8yOTUxMjQ5) (JSTOR stable/2951249). *Note: I verified the paper's existence and venue via its catalogue record; I did not fetch the paywalled full text.*

**"When Trading for a Living Becomes Living for Trading" (TraderFeed, 9 Oct 2009)** [PRIMARY — named practitioner's own blog](http://traderfeed.blogspot.com/2009/10/when-trading-for-living-becomes-living.html):
> *"The sad truth is that **living for trading generally interferes with trading for a living**. By making performance paramount--and allowing performance concerns to dictate one's mood and time expenditures--traders inevitably find that trading is controlling them, not the reverse."*
>
> *"How much time are you spending truly **preparing** for trading vs. **worrying** about it?"*
>
> *"People who spend huge amounts of time consumed with an activity may romanticize their monomania, but most of the time I find that they are **simply inefficient: what they objectively accomplish is no greater than what others achieve with positive mood and attitude in fewer hours**."*
>
> *"Living for trading is the antithesis of freedom and autonomy: **you can't be a free agent if you're a slave to the screen**."*

**Honesty flag on the popular slogans.** The brief asked specifically about *"the market pays you to wait"*, *"I only watch the close"*, and named swing/position traders who check once or twice a day. I searched for these and could **not** trace them to a citable primary source:
- *"The market pays you to wait"* — surfaced only in undated motivational quote-aggregator pages with no attribution to a named trader. **[FOLKLORE — untraceable attribution]**
- Nicolas Darvas' reputed "I only read the closing prices" line surfaced only via a secondary blog aggregator, not from *How I Made $2,000,000 in the Stock Market* directly. **[FOLKLORE / UNVERIFIED]**

See "What I could not find" for the full list. The two Steenbarger posts above are the strongest *traceable* practitioner evidence for the "don't stare at screens" position.

## 8.4 Alarm fatigue — the medical evidence, and the SOC analogue

### Medical / ICU
**Partially covered — the headline "80–99% of alarms are false" figure is NOT verified here.** Several medical primary sources were unreachable during this session (the Joint Commission's Sentinel Event Alert #50 PDF returned HTTP 403 at jointcommission.org and at four mirror URLs; PubMed returned an empty JS shell; nurse.com returned HTTP 403). **Do not cite a specific medical false-alarm percentage on the strength of this brief.**

What *is* verified from primary medical-device-industry material [PRIMARY — ECRI Institute, *Top 10 Health Technology Hazards*, as published in TechNation, February 2015 (PDF)](https://www.ecri.org/Resources/In_the_News/Introducing_ECRI_Institutes_Top_10_Health_Technology_Hazards_for_2015_(TechNation).pdf):
- **Alarm hazards were ECRI's #1 health technology hazard** — *"Alarm hazards again occupy the No. 1 spot on our list of the Top 10 health technology hazards. With the Joint Commission establishing clinical alarm safety as a National Patient Safety Goal, this should come as no surprise."*
- ECRI's recommended remedy is **exactly the alert-tuning discipline** this brief is about: *"we encourage healthcare facilities to expand their alarm safety efforts beyond alarm fatigue to include an assessment of **alarm configuration practices**. Such practices include **determining which alarms should be enabled, selecting the alarm limits to use, and establishing the default alarm priority level**."*
- And the failure mode of not tuning: *"Alarm management strategies that focus too narrowly on alarm fatigue don't address unrecognized alarm conditions… **ECRI Institute has investigated several deaths and other cases of severe patient harm that could have been prevented with more effective alarm configuration policies and practices.**"*

**The traceable bridge from medicine into operations** is Google's own citation: the SRE Book's alert-fatigue footnote cites *"Applying Cardiac Alarm Management Techniques to Your On-Call"* as *"an example of alert fatigue in another context."* [PRIMARY — Google SRE Book, footnote 24](https://sre.google/sre-book/monitoring-distributed-systems/) The engineering profession explicitly imported the medical alarm-management literature, and ECRI's three levers — which alarms are enabled, what the limits are, what priority each gets — are the same three levers a trading desk must set.

### Cybersecurity / SOC — with numbers
The **SANS 2025 Detection and Response Survey** (sponsored by Stamus Networks; 23-page report, PDF fetched) reports [PRIMARY — the survey report itself](https://www.stamus-networks.com/hubfs/SANS%202024%20Documents/2025_Survey_Detection-Response_Stamus.pdf):
- False positives are the **#1 detection challenge in 2025, cited by 73% of respondents** — the survey's own figure table reads *"False positives 73%"*.
- *"False positives surge as a persistent pain point. False positives remain the leading operational burden. This escalation suggests that while detection coverage has expanded, tuning and precision have not kept pace."*
- **Automation is being held back by false positives:** *"Partial automation remained the norm in 2025, with 66% of organizations using at least some automated response, up slightly from 64% last year. **Full automation has slipped to 13% from 16%, likely reflecting ongoing caution around false positives and business impact.**"*
- **Playbooks, not improvisation:** *"Predefined playbooks remained the leading method for automating detection-to-response workflows, adopted by **76% of organizations**, up from 74% last year."*
- **Prioritisation is by business impact, not by technical severity:** *"respondents overwhelmingly pointed to business risk, with **47% ranking potential business impact as their top consideration** and another 30% ranking it second. Severity of the threat closely followed, taking the highest priority for 37%."*

Vendor summary of the same survey adds the frequency data (flag as vendor-authored): *"More than 60% of respondents encounter false positives frequently or very frequently. Even more alarming: 'very frequent' false positives jumped from 13% to 20% year-over-year."* [SECONDARY/vendor — Stamus Networks blog summarising the SANS survey it sponsored](https://www.stamus-networks.com/blog/what-the-2025-sans-detection-response-survey-reveals-false-positives-alert-fatigue-are-worsening)

**The direct bridge from medicine to operations** is Google's own citation of *"Applying Cardiac Alarm Management Techniques to Your On-Call"* in the SRE Book's alert-fatigue footnote. [PRIMARY — Google SRE Book](https://sre.google/sre-book/monitoring-distributed-systems/)

## 8.5 How desks prioritise alerts — tiering, dedup, actionability

The strongest *codified* prioritisation framework found is Google SRE's, and it is unusually directly transferable to a trading desk because the failure mode is identical (a human who stops responding):

**The four questions that must be answered "yes" before an alert is allowed to page a human** (quoted in full in §8.1): otherwise-undetected + urgent + actionable + user-visible; not ignorable; indicates real harm; action can be taken now. [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**Tiering by delivery channel is built into the definition:** Google SRE distinguishes *"tickets"*, *"email alerts"*, and *"pages"* — *"A notification intended to be read by a human and that is pushed to a system such as a bug or ticket queue, an email alias, or a pager."* And it warns that email alerts *"are of very limited value and tend to easily become overrun with noise; instead, you should favor a **dashboard** that monitors all ongoing subcritical problems."* [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**Deliberate alert deletion as policy:** *"Data collection, aggregation, and alerting configuration that is rarely exercised (e.g., less than once a quarter for some SRE teams) should be **up for removal**"* and *"Signals that are collected, but not exposed in any prebaked dashboard nor used by any alert, are candidates for removal."* [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**Alert on symptoms, not causes** — the single highest-leverage signal-to-noise decision: *"Your monitoring system should address two questions: what's broken, and why? The 'what's broken' indicates the symptom; the 'why' indicates a (possibly intermediate) cause… 'What' versus 'why' is one of the most important distinctions in writing good monitoring with maximum signal and minimum noise."* And: *"For paging, black-box monitoring has the key benefit of forcing discipline to only nag a human when a problem is both already ongoing and contributing to real symptoms."* [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**Runbooks / scriptable responses:** *"Pages with rote, algorithmic responses should be a red flag… If a page merely merits a robotic response, it shouldn't be a page."* The Gmail case study describes building tooling so a rote response could be automated. [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**Regulatory tiering requirement in trading:** RTS 6 recital 35 requires surveillance alerts to be *"calibrated to minimise false positive and false negative alerts"* and to be generated *"on the following day at the latest"* — i.e. two distinct alert tiers with different latency budgets (real-time pre-trade/trading alerts at ≤5 seconds per Art. 16(5); next-day market-abuse alerts). [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

**Structural dedup via independence:** both the FIA PTG and RTS 6 require the same control to exist at *multiple independent layers* — *"These risk limits should be implemented in multiple independent pre-trade components of a trading system"* [PRIMARY — FIA PTG](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf) and *"the orders of a DEA client shall always pass through the pre-trade controls that are set and controlled by the DEA provider"* [PRIMARY — RTS 6 Art. 20](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589). Layered controls reduce the need for a human to be the backstop.

## 8.6 Dashboards — what goes on them, and what deliberately doesn't

**Platform-level alert capability (what a professional can actually configure).** TradingView documents the alert types and delivery mechanics [PRIMARY — platform documentation](https://www.tradingview.com/support/solutions/43000529348-about-alerts/):
- Alerts can be triggered on price crossing, indicator conditions, and other conditions, and dispatched to app/email/webhook.
- **Webhooks** are the mechanism that turns a chart alert into a machine action: *"A TradingView webhook notifies your external app when an alert is triggered. Instead of manually checking charts, we can automatically send data via an HTTP POST request to a URL you provide."* [PRIMARY — TradingView webhook documentation](https://www.tradingview.com/support/solutions/43000597494-alerts-how-to-create-and-configure-them/)
- Operational caveats that any desk building on alerts must know: *"If a remote server takes longer than three seconds to process a request, the request will be cancelled"*; *"webhooks may occasionally fail to reach the specified URL. You can monitor their delivery by checking the 'Webhook status' column in the alert log."* [PRIMARY](https://www.tradingview.com/support/solutions/43000597494-alerts-how-to-create-and-configure-them/)

**What a risk dashboard contains — primary evidence.** The FIA PTG recommends *"Each ETS should have a **management console** to display information about the **actions** and **market exposure**. This management console should also provide the trader with the capability to **control** the ETS."* [PRIMARY](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf)

**What a bank risk dashboard contains — primary evidence.** JPMorgan's 10-K enumerates the market-risk measures that are monitored and limited [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm):
- Stress testing
- **Profit and loss drawdowns**
- Earnings-at-risk (EaR)
- Economic value sensitivity (EVS)
- Other sensitivity-based measures
- **VaR** (Firm-level and LOB-level VaR and stress limits)
- **Limit utilisation** — the entity reports *"limit utilizations"* and *"limit breaches"* daily

And the aggregation hierarchy: *"Market Risk Management maintains different levels of limits. Firm level limits include VaR and stress limits. Similarly, LOB and Corporate limits include VaR and stress limits… Limits may also be set within the LOBs and Corporate, as well as at the legal entity level."* [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm)

**What deliberately does NOT go on the paging path.** Google SRE: *"Email alerts are of very limited value and tend to easily become overrun with noise; instead, you should favor a dashboard that monitors all ongoing subcritical problems for the sort of information that typically ends up in email alerts."* Plus: *"Signals that are collected, but not exposed in any prebaked dashboard nor used by any alert, are candidates for removal."* [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

**The measurement-resolution rule** (directly applicable to tick-by-tick trading dashboards): *"Different aspects of a system should be measured with different levels of granularity… for a web service targeting no more than 9 hours aggregate downtime per year (99.9% annual uptime), probing for a 200 (success) status more than once or twice a minute is probably unnecessarily frequent."* And: *"Collecting per-second measurements of CPU load might yield interesting data, but such frequent measurements may be very expensive to collect, store, and analyze."* [PRIMARY](https://sre.google/sre-book/monitoring-distributed-systems/)

## 8.7 The daily "risk run" / exposure check rather than continuous watching

Evidence assembled here is **indirect but consistent**:
- JPMorgan's risk process is described as **daily**: *"JPMorgan SE has its own set of regular market Risk Reports, which include **daily notification of limit utilizations and limit breaches**"*; limits are *"regularly review[ed] and update[d]"*; *"Limits that have not been reviewed within specified time periods by Market Risk Management are reported to senior management."* [PRIMARY — JPMorgan 2024 Annual Report](https://www.jpmorgan.com/content/dam/jpm/global/disclosures/de/english-version-of-disclosures/2024-annual-report-english.pdf)
- The **FIA PTG** frames the daily operational discipline explicitly as a *checklist*, not a watch: *"Trading firms should have written procedures in place to cover ETS day-to-day operations. Tasks may include **confirmation of market connectivity, verification of start-of-day and end-of-day positions** and other critical system or business related tasks."* [PRIMARY — FIA PTG](https://www.fia.org/sites/default/files/2020-04/Trading_Best_Pratices%20-%20published.pdf)
- Bank risk functions run an **end-of-day** process: JPM's *"Regulatory VaR"* and *"Value-at-Risk (VaR)"* are described as a *"daily aggregated VaR"*. [PRIMARY](https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm)
- Exception-based design means the *default* is no human attention: RTS 6 requires *continuous* monitoring **by systems** with alerts escalating to humans only on defined triggers. [PRIMARY](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589)

**Conclusion for the brief:** the professional pattern is **scheduled periodic risk review (start-of-day, end-of-day, daily breach report) + event-driven alerts in between**, not continuous visual monitoring. Google's phrasing — *"carefully avoid any situation that requires someone to 'stare at a screen to watch for problems'"* — is the design principle; JPM's *"daily notification of limit utilizations and limit breaches"* is the institutional implementation; Steenbarger's *"Market Myopia"* is the cognitive justification.

---

# WHAT I COULD NOT FIND

This section is deliberately blunt. Several things the brief asked for could not be traced to a fetched primary source, and in two cases the popular claim appears to be **wrong**.

## Things the brief asked for that turned out NOT to exist as stated

1. **The Turtle "6% monthly / 10% annual stop-trading rule" is not in the original Turtle rules document.** I read the full text of the primary "Original Turtle Trading Rules" document ([mirror](https://kupdf.net/download/turtle-rules_5ee39879e2b6f54c24d2e79a_pdf)). It contains: the 4/6/10/12 unit limits, the 1N = 1% sizing rule, the 2% max risk / 2N stop rule, and a **20%-notional-reduction-per-10%-drawdown ladder**. It does **not** contain a "stop trading for the month at −6%" or "stop trading for the year at −10%" rule. The word "failsafe" in the document refers only to the *"Failsafe Breakout"* — the 55-day breakout used to re-enter after a skipped System 1 signal. **Any brief that cites a Turtle 6%/10% stop-trading rule should either drop it or cite a different source and flag it as a later reconstruction.** I could not find the origin of the 6%/10% claim.

2. **"Risk limits are hard limits" is not bank or regulatory language.** EDGAR full-text search for the exact strings `"risk limits are hard limits"` and `"hard risk limits"` returned **0 results** across all SEC filings. The operative primary terms are *"valid limit breach"* (JPMorgan), *"hard limits"* as a *category* of pre-trade limit (FIA PTG), and *"automatically block or cancel"* (RTS 6).

3. **"The market pays you to wait" is untraceable.** The phrase appears only on undated motivational quote-aggregator pages with no named attribution. Do not attribute it to a specific trader.

4. **Nicolas Darvas' "I only read the closing prices"** could not be verified against Darvas' own book. It surfaces only via secondary blog aggregators. **[FOLKLORE / UNVERIFIED]**

5. **"80–99% of ICU alarms are false"** — see the alarm-fatigue sub-section. The figure is repeated everywhere; tracing it to its actual originating study was attempted by a dedicated delegated research task which did not complete within this session. **Do not use a specific percentage without the original citation.** Note that Google's SRE Book cites *"Applying Cardiac Alarm Management Techniques to Your On-Call"* as its sourced example of medical alarm fatigue, which is a traceable entry point.

## Sources I attempted and could not retrieve

| Source | Result | Workaround used |
|---|---|---|
| sec.gov rule text, press releases, admin orders (multiple URLs) | **HTTP 403** — SEC rate-limits/blocks automated access | Used the Cornell LII mirror of 17 CFR 240.15c3-5; used City AM for the Knight Capital SEC findings; used `efts.sec.gov/LATEST/search-index` (which *does* work) for full-text filing search |
| SEC EDGAR Archives HTML filings (`/Archives/edgar/data/...`) | **HTTP 403** with a browser UA | **HTTP 200** with a UA that includes a contact address (`Research Agent research@example.com`). Use this pattern. |
| Binance help centre / futures services agreement (4 domains, 2 URL forms) | **HTTP 202, empty body** (bot challenge) | None. Binance ADL formula and crypto price-band rules marked [UNVERIFIED] |
| FINRA rule pages (Rule 3110, Regulatory Notice 11-03) and finra.org investor insights | **HTTP 403** | None. FINRA's market-access guidance is **not** covered here. The relevant content is presumably Regulation Notice 11-03 and the 15c3-5 Small Entity Compliance Guide. |
| The5ers' own rules / FAQ / help-centre pages | **HTTP 404** or JS-only, no content | Used a third-party aggregator, flagged [SECONDARY]. **The5ers' numbers are not verified from The5ers' own pages.** |
| Topstep's own Trading Combine rules page | **HTTP 404** at the URL tried | Used Topstep's own Help Center article instead, which *is* primary and gave the MLL numbers |
| NYSE Rule 80B PDF, CME rulebook Rule 575 PDF, CFTC position-limits page | **HTTP 404 / 403** | Used the SEC's investor.gov description of the 7/13/20 halts, plus CME rule filings hosted on cftc.gov, which reproduce the CME rule text verbatim |
| FTMO FAQ answer bodies (news/weekend/consistency) | Rendered by JS; the HTML contains questions but not answers | Used FTMO's Trading Objectives page (which is server-rendered and gave the numbers) and the Forbidden Trading Practices page |
| Investopedia (swing-trading routine) | **HTTP 403** | None |
| Internet Archive / Wayback Machine | **HTTP 503 — "Internet Archive services are temporarily offline"** during this session | None. This blocked recovery of dead Turtle-rules URLs. Retry later. |
| `web_fetch` on any PDF | `Error: unsupported content type "application/pdf"` | Used `curl` to download + `pypdf` to extract text. **This is the required workaround for all PDF sources.** |

## Substantive gaps in coverage

- **FINRA market-access guidance** — not covered (403).
- **Basel / FRTB primary text on trading-book limits and the CRO reporting line** — the BIS PDF URL tried (`bcbs/publ/d328.pdf`) returned HTML/JS rather than a PDF, and the BIS Basel Framework chapter page was not retrieved. The CRO-independence and limit-governance evidence in §6.3 therefore rests on JPMorgan's SEC filing rather than on the Basel Principles. The relevant BIS documents to fetch next: *Corporate governance principles for banks* (BCBS d328, July 2015) and the Basel Framework chapter **SRP 33** (market risk supervisory guidance).
- **"Limit breach escalation" as a *named procedure* with a documented escalation ladder** — JPMorgan describes escalation but does not publish the ladder (durations, tiers, who is notified at what age of breach). No bank publishes this; it would need a regulator's supervisory finding, a court/administrative filing, or a risk-management textbook to evidence.
- **Hedge-fund-specific** risk limits (as opposed to bank and managed-futures) — largely absent. Hedge funds are private and do not publish their risk manuals. The closest available proxies are managed-futures/CTA practice (Turtle rules, Carver) and the bank evidence.
- **Crypto prop firm rules from the firms' own pages** — not attempted to primary standard.
- **Binance ADL ranking formula, crypto exchange price bands, crypto exchange position limits** — blocked (see table).
- **A named, traceable practitioner account of a literal "daily risk run"** with a checklist — the FIA PTG's *"confirmation of market connectivity, verification of start-of-day and end-of-day positions"* is the closest primary evidence, but it is a recommendation, not a documented routine. JPMorgan's *"daily notification of limit utilizations and limit breaches"* is the institutional analogue. A verbatim desk checklist would require a bank's internal procedures, a regulator's inspection report, or a practitioner memoir/interview.
- **Alarm fatigue: the medical numbers.** The 80–99% ICU false-alarm figure and the Joint Commission Sentinel Event Alert #50 numbers (alarm-related deaths 2005–2010) are **not** verified here — jointcommission.org returned HTTP 403 for the PDF and four mirror URLs 404'd; PubMed returned an empty JS shell; nurse.com returned HTTP 403. **ECRI's ranking of alarm hazards as its #1 health technology hazard for 2015 *is* verified** (see §8.4). The SANS/SOC figures in §8.4 *are* verified. Anyone needing the medical numbers should retry jointcommission.org and PubMed directly, or use a library/PDF proxy — the sources exist, they were simply not reachable from this session.
- **Futures-industry "kill switch" product documentation** from CME/Nasdaq/ICE — not retrieved; the requirement-level evidence (RTS 6 Art. 12, FIA PTG) is used instead.
