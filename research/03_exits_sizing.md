# 03 — Exits & Position Sizing (Q4 + Q5)

**Scope:** Q4 (exits vs entries — which side is more mechanical?) and Q5 (position sizing is a formula, not a judgement).

**Method note.** Every claim below carries an inline link to a URL that was actually fetched during this research. Source-quality flags:

- **[PRIMARY]** — named practitioner / named desk / named author / academic paper / regulatory filing.
- **[SECONDARY]** — journalism, reference documentation, or a compilation of primary material.
- **[FOLKLORE]** — unsourced blog assertion, SEO content, or a "standard" claim with no traceable primary source.

Where a widely repeated "standard" (e.g. *"professionals risk 1–2% per trade"*) has no solid primary source, that is stated explicitly rather than smoothed over.

---

# PART Q4 — EXITS vs ENTRIES

## Q4.0 The headline finding

The primary sources converge on a specific and asymmetric answer:

> **Sizing and initial stop placement are formulas. Initial exits (stops) are near-universally pre-specified and non-negotiable. Profit-taking exits are where the discretion lives — and the practitioner literature is explicit that this discretion is the main way traders destroy a system's edge.**

Three independent lines of evidence:

1. **The Turtle programme** taught a fully mechanical system, and the founders' own post-mortem attributes failures to rule-breaking, not to bad rules: *"many of them did not make money. This was not because the rules didn't work; it was because they could not and did not follow the rules."* ([The Original Turtle Trading Rules, 2003, ch. 8](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**
2. **Turtle exits were the hardest part precisely because they were mechanical:** *"For most traders, the Turtle System Exits were probably the single most difficult part of the Turtle System Rules. Waiting for a 10 or 20 day new low can often mean watching 20%, 40% even 100% of significant profits evaporate. There is a very strong tendency to want to exit earlier."* ([ibid., ch. 6](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**
3. **Named CTAs describe "signals" as mechanical but reserve the right to override.** Quantitative Investment Management's own SEC-filed programme description: *"The execution of QIM's trading strategy is systematic. All facets of the predictive models, risk management, and trade allocation are fully automated. However... The trading is discretionary in that final decisions are made, and systems occasionally overridden, based on the full set of information."* ([Frontier Fund S-1, SEC EDGAR, 2012](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY — regulatory filing]**

---

## Q4.1 Initial stop placement — the standard formulas

### (a) The Turtle "N"-unit stop (the canonical volatility stop)

The original Turtle document defines **N** as Wilder-smoothed ATR, and derives the stop directly from the risk budget.

**True Range:** ([Original Turtle Rules, ch. 3](https://drive.google.com/file/d/1lSlj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view))

```
True Range = Maximum(H - L, H - PDC, PDC - L)
  H   = current High
  L   = current Low
  PDC = Previous Day's Close
```

**N (20-day Wilder-smoothed ATR):**

```
N = (19 x PDN + TR) / 20
  PDN = Previous Day's N
  TR  = Current Day's True Range
```
> *"Since this formula requires a previous day's N value, you must start with a 20-day simple average of the True Range for the initial calculation."* **[PRIMARY]**

**Dollar Volatility:** `Dollar Volatility = N x Dollars per Point` **[PRIMARY]**

**Unit (position size):**
```
Unit = (1% of Account) / Dollar Volatility
     = (0.01 x Account Equity) / (N x Dollars per Point)
```
Worked example from the document: Heating Oil, N = 0.0141, Account = $1,000,000, Dollars per Point = 42,000 → `Unit = (0.01 x 1,000,000) / (0.0141 x 42,000) = 16.88` → truncated to 16 contracts. **[PRIMARY]**

**Stop:** `Long stop = Entry - 2N`; `Short stop = Entry + 2N`

> *"The Turtles placed their stops based on position risk. No trade could incur more than 2% risk. Since 1 N of price movement represented 1% of Account Equity, the maximum stop that would allow 2% risk would be 2 N of price movement. Turtle stops were set at 2 N below the entry for long positions, and 2 N above the entry for short positions."* ([Original Turtle Rules, ch. 5](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

Note the identity: because the unit is sized so that 1N = 1% of equity, a 2N stop is *by construction* a 2%-of-equity loss. This is the cleanest primary-source statement of the "sizing is a function of stop distance" principle in existence.

**Pyramiding / stop ratchet:** add one unit every ½N in favour; when a unit is added, stops on *all* units move to 2N from the most recent entry: *"if additional units were added, the stops for earlier units were raised by ½ N. This generally meant that all the stops for the entire position would be placed at 2 N from the most recently added unit."* **[PRIMARY]**

**The "Whipsaw" alternate stop (a tighter variant the Turtles were told about):** *"Instead of taking a 2% risk on each trade, the stops were placed at ½ N for ½% account risk. If a given Unit was stopped out, the Unit would be re-entered if the market returned to the original entry price... the total risk would never exceed 2% at the maximum four Units."* **[PRIMARY]**

**Position-count limits (portfolio-level risk caps):** 4 units per single market; 6 units in closely correlated markets; 10 units in loosely correlated markets; 12 units in a single direction. ([ch. 3](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

### (b) ATR-multiple stops (1.5x / 2x / 3x)

The 2x−3x ATR range is the practitioner default. StockCharts documents `ATR Trailing Stops` with a default 21-period ATR and a **3x** multiplier, noting *"The choice of multiplier (such as 2x, 3x, or higher) depends on the anticipated level of volatility and the aggressiveness of your risk management approach."* ([StockCharts ChartSchool — ATR Trailing Stops](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/atr-trailing-stops.md)) **[SECONDARY]**

Chuck LeBeau's original bulletin gives an explicit *initial* range: *"At the beginning of a trade the distance to the stop in most futures markets should probably be in the neighborhood of **2.5 to 4 Average True Ranges**."* ([LeBeau, *Trailing Stops — The Chandelier Exit*](https://idoc.pub/documents/chuck-lebeau-trailing-stops-chandelier-strategy-mwl183q7zj4j)) **[PRIMARY]**

**Honest note:** the specific pairings "1.5x ATR for day trading, 2x for swing, 3x for position" that circulate widely are **not** traceable to a primary source in this research; treat the *range* (≈1.5x–4x) as documented and the specific per-style numbers as [FOLKLORE].

### (c) Structure-based stops

Structure-based placement is standard practice but weakly documented in primary sources. One named-author example: *"Stop losses should always make sense, positioned below recent support, or above resistance for short trades. Catalyst Metals (CYL) made a recent low at 7.00 in the example below and we position our stop a few points below at 6.95."* (Colin Twiggs, IncredibleCharts, [Alexander Elder's 6 Percent Rule](https://www.incrediblecharts.com/trading/6_percent_rule.php)) **[SECONDARY — named author, educational site]**

A regulatory filing describing a discretionary CTA (Tiverton) gives the practitioner logic: *"Tiverton takes an important countertrend position only when clear stop-loss chart points exist to limit losses."* ([Frontier Fund S-1](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

### (d) MAE-based stops (maximum adverse excursion)

MAE measures how far price ran against a trade before it resolved. The design rule: set the stop beyond the MAE distribution of *winning* trades, so winners are not prematurely stopped.

Definition: *"MAE is calculated by reviewing a set of winning and/or losing trades to find the maximum distance the price moved against the trader's position from the entry point before exiting the trade with a profit or loss."* Drawdown (long): entry price minus the lowest price reached before the price started rising. Short trade: entry price minus the highest price reached. ([NinjaTrader, *Managing Trade Risk Using Probabilities*, 19 Jun 2024](https://ninjatrader.com/futures/blogs/managing-trade-risk-using-probabilities/)) **[SECONDARY — platform/desk educational content]**

The originating text is John Sweeney's *Maximum Adverse Excursion* (Wiley, 1997) ([publisher/library record](https://www.akademibokhandeln.se/bok/maximum-adverse-excursion/9780471141525)) **[PRIMARY — book, not fetched in full]**.

### (e) Academic evidence on whether stops help at all

Kaminski & Lo derive the conditions under which stop-loss rules add or destroy value: *"under the Random Walk Hypothesis, simple 0/1 stop-loss rules always decrease a strategy's expected return, but in the presence of momentum, stop-loss rules can add value."* Empirically, on US equities 1950–2004 with long bonds as the stop-out asset, *"certain stop-loss rules add 50 to 100 basis points per month to the buy-and-hold portfolio during stop-out periods."* (Kaminski & Lo, *When Do Stop-Loss Rules Stop Losses?*, SIFR WP 63, 2008, [abstract](https://swopec.hhs.se/sifrwp/abs/sifrwp0063.htm)) **[PRIMARY — academic]**

This is the key theoretical point: **a stop is not free alpha.** It is a variance/behavioural device that pays only to the extent the underlying process is trending.

---

## Q4.2 Breakeven stops

**Finding: this is the weakest-evidenced item in Q4.** Practitioner content asserting "move to breakeven" is abundant ([FOLKLORE] — e.g. SEO guides), but I could not find a primary source that *quantifies* the effect of moving a stop to breakeven, and I could not find a named practitioner who defends the practice with data.

What the primary sources do say, indirectly:

- LeBeau's framework treats stop-tightening as a function of *profit accumulated*, not of breakeven: *"as profits are accumulated, tighten the stop by reducing the number of bars in the Channel... After we have reached our first profit level we might tighten the stop to trail the high point at only 1.5 ATRs. After the second profit level is reached we might want to tighten the trailing stop to only one ATR. We have had good results with some highly profitable trades by trailing exits as close as a half an ATR."* ([LeBeau](https://idoc.pub/documents/chuck-lebeau-trailing-stops-chandelier-strategy-mwl183q7zj4j)) **[PRIMARY]** — note this is a *volatility-scaled* tightening schedule, not a breakeven rule.
- The Turtle system has **no** breakeven rule. Stops move only when units are added (to 2N from the newest entry), which is mechanically equivalent to a partial breakeven only at the 4th unit. ([Original Turtle Rules](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**
- Kaminski & Lo's framework (above) implies that any stop-tightening rule must be justified by momentum/autocorrelation, not by the desire to avoid regret. **[PRIMARY]**

**Honest conclusion:** "move the stop to breakeven once +1R" is a widely taught convention with **no primary source quantifying its expectancy impact**. Flag as [FOLKLORE] unless a specific desk's manual is produced.

---

## Q4.3 Trailing stops

### (a) Chandelier Exit — LeBeau's original formula

Primary text (LeBeau's own bulletin):

> *"1. Place a stop at the highest high since we entered the trade minus three Average True Ranges."*
> *"The reason we prefer to use units of Average True Range to measure the distance from the high to our stop is that the ATR is applicable across markets and is adaptive to changes in volatility."*
> *"We normally use about twenty bars to calculate the ATR unless there is a specific reason to adjust it."*
([LeBeau, *Trailing Stops — The Chandelier Exit*](https://idoc.pub/documents/chuck-lebeau-trailing-stops-chandelier-strategy-mwl183q7zj4j)) **[PRIMARY]**

The packaged indicator form (22-day lookback, 3x multiplier) is documented at StockCharts:

```
Chandelier Exit (long)  = 22-day High  - ATR(22) x 3
Chandelier Exit (short) = 22-day Low   + ATR(22) x 3
```
([StockCharts ChartSchool — Chandelier Exit](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit.md)) **[SECONDARY — formula consistent with LeBeau; the "22" comes from the number of trading days in a month]**

LeBeau's own tightening schedule (2.5–4 ATR initially → 1.5 ATR → 1 ATR → as tight as 0.5 ATR) is quoted in Q4.2. He also combines it with a slower Donchian-style "Channel Exit" early in a trade, switching to the Chandelier once profitable. **[PRIMARY]**

**The strongest single quote for Q4's headline question** — LeBeau's account of how he learned that exits dominate entries, and the Tharp study he cites:

> *"In Dr. Van K. Tharp's excellent book, Trade Your Way to Financial Freedom, he refers to a study he conducted to demonstrate that an effective exit strategy could produce profits even with random entries. We were not surprised to see that the exit methodology he used to produce the profitable test results across a diversified portfolio of futures markets was the Chandelier Exit."* **[PRIMARY]**

### (b) ATR trailing stop (generic)

```
Long:  Stop_t = max(Stop_{t-1}, HighestHigh(since entry) - m x ATR(n))
Short: Stop_t = min(Stop_{t-1}, LowestLow(since entry)   + m x ATR(n))
```
Only ratchets in the favourable direction. StockCharts' default: ATR(21), m = 3. ([StockCharts — ATR Trailing Stops](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/atr-trailing-stops.md)) **[SECONDARY]**

### (c) Parabolic SAR — Welles Wilder's formula

Wilder introduced the Parabolic Time/Price System in *New Concepts in Technical Trading Systems* (1978).

```
RISING SAR:
  Current SAR = Prior SAR + Prior AF x (Prior EP - Prior SAR)
  EP = highest high of the current uptrend
  AF starts at 0.02, increases by 0.02 on each new extreme point, capped at 0.20
  Constraint: SAR can never be above the prior two periods' lows (use the lower)

FALLING SAR:
  Current SAR = Prior SAR - Prior AF x (Prior SAR - Prior EP)
  EP = lowest low of the current downtrend
  Constraint: SAR can never be below the prior two periods' highs (use the higher)
```
Worked example from the source: `13-Apr-10 SAR = 48.28 = 48.13 + .14(49.20 - 48.13)`. ([StockCharts ChartSchool — Parabolic SAR](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/parabolic-sar.md)) **[SECONDARY — reference documentation of Wilder 1978]**

Generalised form: `SAR_n = SAR_{n-1} + AF x (EP - SAR_{n-1})`, AF start 0.02, step 0.02, max 0.2 ([cTrader Help — Parabolic SAR](https://help.ctrader.com/indicators/zh/built-in/trend/parabolic-sar/)) **[SECONDARY]**

Key structural property: *"SAR trails price as the trend extends over time... **SAR never decreases in an uptrend** and continuously protects profits as prices advance. The indicator acts as a guard against the propensity to lower a stop-loss."* ([StockCharts](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/parabolic-sar.md)) **[SECONDARY]** — i.e. the indicator is explicitly designed to *mechanically remove* the discretionary "give it a bit more room" decision.

Wilder's own estimate: *"the Parabolic SAR works best with trending securities, which occur roughly 30% of the time. This means the indicator will be prone to whipsaws over 50% of the time."* **[SECONDARY]**

### (d) Donchian / channel trailing exits

The origin: Richard Donchian's 1960 "weekly trading rule": *"When the price moves above the high of two previous calendar weeks... cover your short positions and buy. When the price breaks below the low of the two previous calendar weeks, liquidate your long position and sell short."* ([TurtleTrader — The Original Turtle Trading Rules](https://www.turtletrader.com/rules/)) **[SECONDARY — Covel's site reproducing Donchian; the wording is quoted from Barbara Dixon's description of Donchian]**

Donchian's student's framing is the philosophical root of mechanical exits: the trend follower *"disciplines his thoughts into a strict set of conditions for entering and exiting the market and acts on those rules or his system to the exclusion of all other market factors. This removes, hopefully, emotional judgmental influences from individual market decisions."* ([ibid.](https://www.turtletrader.com/rules/)) **[SECONDARY]**

### (e) Turtle 10-day / 20-day breakout exits

> *"The System 1 exit was a 10 day low for long positions and a 10 day high for short positions. All the Units in the position would be exited if the price went against the position for a 10 day breakout. The System 2 exit was a 20 day low for long positions and a 20 day high for short positions."*
> *"As with entries, the Turtles did not typically place exit stop orders, but instead watched the price during the day, and started to phone in exit orders as soon as the price traded through the exit breakout price."*
([Original Turtle Rules, ch. 6](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

Also note the exit-asymmetry analysis, which is the Turtle document's own statement of expectancy arithmetic:

> *"Consider the Turtle System; if you exit winning positions at a 1 N profit while you exited losing positions at a 2 N loss you would need twice as many winners to offset the losses from the losing trades."* **[PRIMARY]**

---

## Q4.4 Scaling out / partial profit taking

### The mathematics of why scaling out is usually negative-expectancy

The structural argument, from the sources below:

- Scaling out is **not** a free option. Selling half at +1R and letting the rest run produces a blended exit whose expected value is the weighted average of the two exit rules.
- If both exit rules have the same per-unit expectancy, scaling out changes **variance and path**, not **expectancy** — you have simply traded one position for two smaller positions with different exits.
- The expectancy *falls* whenever the early exit rule has lower per-unit expectancy than the runner rule. In trend following, where the right tail carries the return, cutting the winner early mechanically removes exposure to the exact trades that pay for everything else.

### Evidence FOR the negative-expectancy view

**Trend-following backtest (named practitioner, own test).** Adrian Reid tested partial profit-taking on a 200-day-breakout trend system on ASX stocks (exit: 25% trailing stop below highest price since entry; 1,432 trades; base return 21.6%, max DD 41.7%, MAR 0.52). Optimising profit target (0.25→1.50) × fraction reduced (0→100%):

> *"Across all combinations tested, every instance of partial profit taking reduced the overall rate of return compared to the base trend following system. Every single one."*
> *"Interestingly, every combination of profit target and position reduction reduced maximum drawdown... Apart from one isolated outlier at a 75% profit target with 100% position reduction, every other combination produced an equal or worse MAR ratio."*
([Enlightened Stock Trading — *Trend Following Profit Targets: Do They Work?*](https://enlightenedstocktrading.com/trend-following-profit-targets-do-they-work/)) **[PRIMARY — named practitioner, own backtest; not peer-reviewed; commercial site]**

**The Turtle document's position** is explicitly anti-early-profit:

> *"There is another old saying: 'you can never go broke taking a profit.' The Turtles would not agree with this statement. Getting out of winning positions too early, i.e. 'taking a profit' too early, is one of the most common mistakes when trading trend following systems."*
> *"Prices never go straight up; therefore it is necessary to let the prices go against you if you are going to ride a trend. Early in a trend this can often mean watching decent profits of 10% to 30% fade to a small loss. In the middle of a trend, it might mean watching a profit of 80% to 100% drop by 30% to 40%. The temptation to lighten the position to 'lock in profits' can be very great."*
> *"The proper exit for winning positions is one of the most important aspects of trading, and the least appreciated."*
([Original Turtle Rules, ch. 6](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

### Evidence FOR the pro-scaling-out view

**Dean Hoffman, TradingMarkets (2003)** ran a 21-market, 10-year trend test and reported that adding a second contract with a partial-exit rule raised net profit far more than it raised drawdown:

> *"instead of a one-to-one increase in profits and drawdowns net profits increased by $470,671 yet the drawdown only increased by $8,511!"*
> Two-contract with partial exits: Net profit $1,143,978; Max $ drawdown $69,015; % winners 38%; Avg $Win : Avg $Loss = 3.75.
> Final summary: base single-contract system made $673,307 with a $60,504 drawdown; with partial exits + equal weighting it made $1,377,451 with a $51,445 drawdown.
> *"It's important to note that not all systems have performance increases when adding the above strategies. In fact, some of them actually see a large performance decrease."*
([TradingMarkets — *Using Partial Exits And Position Sizing To Improve Performance Results*, 23 Sep 2003](https://tradingmarkets.com/recent/Using_Partial_Exits_And_Position_Sizing_To_Improve_Performance_Results-659906)) **[PRIMARY — named author, own backtest; promotional trading-education site, 2003, no out-of-sample]**

**Reconciliation:** the two tests differ in a way that matters. Hoffman's partial exit is combined with *doubling the number of contracts* and with equal weighting — so total position size is being *increased*, and the "improvement" is at least partly a leverage/compounding effect, not a pure exit effect. Reid holds sizing roughly constant (as a % reduction of the same position) and isolates the exit. **Read together, the cleaner experiment (Reid) supports the negative-expectancy view; the Hoffman result is confounded by sizing.** This is exactly the kind of confounding that makes "partial exits work" claims unreliable.

**LeBeau's own nuance** — he explicitly wrote an article titled *"Why Use Multiple Exits?"*, i.e. he did advocate multiple exits as a way to handle the *control asymmetry* between losses and profits: *"we can strictly control losses but it is extremely discomforting to realize that we have very little control of our profits... they can be controlled in the sense that we don't have to let them become smaller or turn into losses."* ([LeBeau, *Taking Control*](https://forums.stockfetcher.com/forums/General-Discussion/Taking-Control-by-Chuck-LeBeau/61642)) **[PRIMARY — named practitioner, article reposted on a forum]**

### Named prop-desk practice: "Reasons2Sell"

SMB Capital (Mike Bellafiore) teaches a discretionary, pre-enumerated exit list rather than a fixed R-multiple scale-out: *"On our prop desk I encourage our traders to look for stocks that are trending, enter a Trade2Hold, and stay in the position if it is working until there is a Reason2Sell."* Examples given: the stock hits your target *and* shows weakness on the tape; or a **Time Stop** fires. ([SMB — *The Time Stop (an Example in $YUM)*](https://www.smbtraining.com/blog/the-time-stop-an-example-in-yum); [SMB — *Reasons2Sell*](https://www.smbtraining.com/blog/an-exit-strategy-to-add-to-your-trading-reasons2sell)) **[PRIMARY — named prop desk]**

Crucially Bellafiore frames the exit as *pre-specified but judgment-triggered*: *"First, you must learn how to Read the Tape. Second, you must develop your list of Reasons2Sell. Lastly, you must practice executing your exit strategy before it becomes internalized."* ([SMB](https://www.smbtraining.com/blog/an-exit-strategy-to-add-to-your-trading-reasons2sell)) **[PRIMARY]**

---

## Q4.5 Time stops

**Definition (named prop desk):** *"As traders it is a good habit to set a time clock in your head for when you expect a stock to move. If the stock does not move in the time you think it should then you can reduce your risk, lighten up in your position. Said another way, you can have a Time Stop for your position."* ([SMB Capital / Mike Bellafiore, 12 Mar 2013](https://www.smbtraining.com/blog/the-time-stop-an-example-in-yum)) **[PRIMARY — named prop desk]**

**Systematic CTA practice (regulatory filing):** QuantMetrics' programme description states *"Disciplined risk management is built into each trading algorithm, with **time stops and stop losses strictly adhered to**."* ([Frontier Fund S-1, SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY — regulatory filing]**

**LeBeau's related time element:** his "25 x 25" Bond System uses *"a very tight channel to help lock in profits after twenty-five days or after five Average True Ranges of profit."* ([LeBeau, *Taking Control*](https://forums.stockfetcher.com/forums/General-Discussion/Taking-Control-by-Chuck-LeBeau/61642)) **[PRIMARY]**

**Honest note:** I found **no quantitative study** of time stops (e.g. "exit after N bars improves expectancy by X"). The only counter-argument encountered is an unsourced forum comment claiming time is a weaker component than price ([comment on SMB post](https://www.smbtraining.com/blog/the-time-stop-an-example-in-yum)) — that is [FOLKLORE] and should not be treated as evidence. Time stops are documented *practice*, not documented *edge*.

---

## Q4.6 R-multiples, expectancy, and SQN (Van Tharp's framework)

**R (1R) — the unit of risk.** Van Tharp himself: *"Predetermined Risk (1R). I have said for many years that you should not enter into a trade without knowing when you are wrong about the trade and having a stop order in at that point. For example, a good substitute for buy and hold in the stock market is the 25% trailing stop. Your initial risk should be 25% of the entry price... With a trailing stop, every time the stock makes a higher close you should raise your stop so that a 25% drop from the current level gets you out."* ([Van K. Tharp, Ph.D., *Risks in Trade: Understanding All*, Van Tharp Institute](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/)) **[PRIMARY]**

**Position sizing risk, in Van Tharp's own words — and the 1% norm:** *"Position Sizing Risk. It's your total risk when you multiply 1R times the number of shares that you purchase. **For most of you that should equal about 1% of your portfolio.**"* ([ibid.](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/)) **[PRIMARY — this is the closest thing to a primary source for a "1% per trade" norm]**

**Expectancy (the standard formulation):**

```
Expectancy ($)  = (Win%  x Average Win)  - (Loss% x Average Loss)
Expectancy (R)  = (Win%  x Average Win in R) - (Loss% x Average Loss in R)
```
Van Tharp's definition, as characterised by a named quant author: *"Expectancy, as Van Tharp defines it, is just the expected profit per trade of the system expressed as a multiple of R."* And R itself: *"R is a central concept of Van Tharp's methodology, which he defines as how much you will lose per unit of your investment... if you buy a stock today for $50 and plan to sell it if it reaches $40, your R is $10... Van Tharp sensibly recommends you use your average loss as an estimate of R"* when no stop is defined. (Jonathan Kinlay, [*Money Management — the Good, the Bad and the Ugly*, 23 Sep 2018](https://jonathankinlay.com/2018/09/)) **[PRIMARY — named quant author summarising Van Tharp's book; the formula itself is the standard one]**

**SQN (System Quality Number):**

```
SQN = (Expectancy / Standard Deviation of R) x sqrt(Number of Trades)
```
([Kinlay, ibid.](https://jonathankinlay.com/2018/09/)) **[PRIMARY — named author]**

**The informed critique of SQN:** Kinlay shows algebraically that SQN reduces to a rescaled Sharpe ratio. Squaring both sides and cancelling the R² terms:

```
SQN = (Average Profit per Trade / Standard Deviation of Average Profit per Trade) x sqrt(Number of Trades)
```
> *"There is another name by which this measure is more widely known in the investment community: the **Sharpe Ratio**."*
And on the prescription to trade only systems with SQN ≥ 2 (ideally 3–6): *"95% or more of investable strategies have a Sharpe Ratio less than 2. In fact, in the world of investment management a Sharpe Ratio of 1.5 is considered very good... Only in the world of high frequency trading do strategies typically attain the kind of Sharpe Ratio (or SQN) that Van Tharp advocates. So while Van Tharp's intentions are well meaning, his prescription is unrealistic, for the majority of investors."* ([Kinlay, ibid.](https://jonathankinlay.com/2018/09/)) **[PRIMARY — named quant author, critical analysis]**

Kinlay also credits Van Tharp with *"demolishing highly speculative and very dangerous 'money management' techniques such as the Kelly Criterion and Ralph Vince's Optimal f, which make unrealistic assumptions of one kind or another... Just as with the Martingale, these techniques will often produce unacceptably large drawdowns."* **[PRIMARY]**

---

## Q4.7 "Let winners run" vs "take profit" — the behavioural evidence

### The disposition effect

- **Shefrin & Statman (1985)**, *"The Disposition to Sell Winners Too Early and Ride Losers Too Long: Theory and Evidence"*, Journal of Finance 40(3). This is the paper that named the disposition effect. ([Wiley record](https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.1985.tb05002.x)) **[PRIMARY — academic]**
- **Odean (1998)**, *"Are Investors Reluctant to Realize Their Losses?"*, Journal of Finance 53(5). ([Wiley record](https://onlinelibrary.wiley.com/doi/full/10.1111/0022-1082.00072); [open record via scholar.archive.org](https://scholar.archive.org/work/iugw2rtxsfeq3jhnlatijhvecq)). **[PRIMARY — academic]**
- **Related:** *"Is the Aggregate Investor Reluctant to Realise Losses? Evidence from Taiwan"* ([Wiley](https://onlinelibrary.wiley.com/doi/10.1111/j.1468-036X.2007.00367.x)) — extends the finding outside the US. **[PRIMARY — academic]**

**Honest limitation:** the exact headline statistics from Odean (the PGR/PLR ratio, the December tax-loss-selling pattern, and the ~3.4% annual performance penalty) could **not** be verified by fetching the full text during this pass — only the abstracts/records. The full-text PDF citations for these numbers should be re-verified before publication. What *is* verified from the fetched records is that both papers exist and that Odean's paper is the canonical empirical test of the disposition effect in retail brokerage data.

### Fat right tails in trend following

- **CFM (Capital Fund Management), *"Making fat right tails fatter with trend following… most of the time"* (Nov 2018):** *"this convexity leads to a positively skewed returning strategy, which in turn then becomes a performance chaser's nightmare – selling after prolonged periods of inevitable disappointing performance before missing the next, unpredictable acceleration in positive performance. We contrast this with the P&Ls of most other strategies and assets that are predominantly negatively skewed."* And the definition: *"A positively skewed strategy... is one where many small losses, but a few large gains are registered. Buying options, for example, is a positively skewed strategy."* ([CFM technical note landing page](https://www.cfm.com/making-fat-right-tails-fatter-with-trend-following-most-of-the-time/); [PDF](https://www.cfm.com/wp-content/uploads/2022/12/188-2018-Making-fat-right-tails-fatter-with-trend-following-most-of-the-time.pdf)) **[PRIMARY — named quant fund]**
- **Important honest caveat from the same paper:** CFM shows that the *daily* skew of a 100-day trend strategy *"has evolved over time from being positive to negative"*, and attributes this to the disappearance of short-term (few-day) autocorrelation rather than to crowding. They argue the convexity/skew properties hold *"over timescales comparable to that of the trend approach employed"*, not at daily frequency. So "trend following is positively skewed" is a **horizon-dependent** claim, not an unconditional one. **[PRIMARY]**
- **AQR, Hurst / Ooi / Pedersen, *"A Century of Evidence on Trend-Following Investing"* (31 Oct 2017):** a time-series momentum strategy constructed back to 1880 *"was consistently profitable over the next 110 years."* ([AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)) **[PRIMARY — named desk]** — supports the persistence of the trend premium but does **not** by itself quantify "the majority of profit comes from a small number of trades."

**Honest finding:** I could not locate a rigorous, citable quantification of the specific claim *"the majority of profit comes from a small number of trades"* in a mainline academic source. The claim is directionally supported by the CFM convexity/skew work and by the Turtle document's exit arithmetic, but the specific X%-of-trades-generate-Y%-of-profits number should be treated as **[FOLKLORE]** unless a study is produced.

---

## Q4.8 Trend following / CTA exit practice and the Market Wizards record

### Market Wizards quotes on stops and exits

Compiled at TurtleTrader (Michael Covel's site) with attributions. All are quotes from Jack Schwager's *Market Wizards* interviews. ([TurtleTrader — Market Wizards Quotes on Risk, Losses and Trading Psychology](https://www.turtletrader.com/market-quotes/)) **[SECONDARY — compilation of primary interviews; I verified the quotes are attributed on the page but did not fetch the Schwager books themselves]**

| Trader | Quote |
|---|---|
| Ed Seykota | *"The elements of good trading are: (1) cutting losses, (2) cutting losses, and (3) cutting losses. If you can follow these three rules, you may have a chance."* |
| Paul Tudor Jones | *"If I have positions going against me, I get right out; if they are going for me, I keep them… Risk control is the most important thing in trading. If you have a losing position that is making you uncomfortable, the solution is very simple: Get out, because you can always get back in."* |
| Paul Tudor Jones | *"Don't focus on making money; focus on protecting what you have."* |
| Larry Hite | *"Throughout my financial career, I have continually witnessed examples of other people that I have known being ruined by a failure to respect risk. If you don't take a hard look at risk, it will take you."* |
| Larry Hite | *"Frankly, I don't see markets; I see risks, rewards, and money."* |
| Bruce Kovner | *"[Michael Marcus] taught me one other thing that is absolutely critical: You have to be willing to make mistakes regularly; there is nothing wrong with it... making your best judgement, being wrong, making your next best judgement, being wrong, making your third best judgement, and then doubling your money."* |
| Tony Saliba | *"I always define my risk, and I don't have to worry about it."* |
| Randy McKay | *"I'll keep reducing my trading size as long as I'm losing… My money management techniques are extremely conservative. I never risk anything approaching the total amount of money in my account, let alone my total funds."* |
| Marty Schwartz | *"Learn to take losses. The most important thing in making money is not letting your losses get out of hand."* |
| Victor Sperandeo | *"the single most important reason that people lose money in the financial markets is that they don't cut their losses short."* |
| **Tom Basso** | *"I think investment psychology is by far the more important element, followed by risk control, with the least important consideration being the question of where you buy and sell."* |

**Basso's quote is the single most direct primary-attributed statement of the "entries/exits matter least" thesis** — and note that it ranks *risk control* (sizing) above *entry/exit selection*, not just exits above entries.

### "Entries are the easy part" — Chuck LeBeau

> *"As I often point out in my lectures, entries are the easy part of trading. This is because each of us has maximum control at this point... However the control situation changes drastically once we enter the trade... Exits are much more difficult than entries because we can not simply reverse the entry process and require that the market do thus and such."*
([LeBeau, *Taking Control*](https://forums.stockfetcher.com/forums/General-Discussion/Taking-Control-by-Chuck-LeBeau/61642)) **[PRIMARY]**

> *"I am very fortunate that more than 30 years ago I learned from the Coke bottle trader that **success in trading depends on our exits and not our entries**."*
([LeBeau, *Trading Messages from Mars*, reproduced at Capitalogix](https://capitalogix.com/2015/10/chuck-lebeau-on-the-importance-of-exits)) **[PRIMARY — LeBeau's own story, reposted]**

### The Turtle founders on the same point

> *"The typical trader thinks mostly in terms of the entry signals when thinking about a particular trading system. They believe that the entry is the most important aspect of any trading system. They might be very surprised to find that the Turtles used a very simple entry system based on the Channel Breakout systems taught by Richard Donchian."*
> *"Money Management is the most important aspect of a mechanical trading system."*
([Original Turtle Rules, ch. 4 and ch. 8](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

Richard Dennis, quoted on the same site: *"The majority of the other things that didn't work were judgments. It seemed that the better part of the whole thing was rules. You can't wake up in the morning and say, 'I want to have an intuition about a market.' You're going to have way too many judgments."* ([TurtleTrader — The Original Turtle Trading Rules](https://www.turtletrader.com/rules/)) **[SECONDARY — Covel's site quoting Dennis]**

### Where discretion is explicitly permitted in the Turtle programme

Worth flagging precisely, because it shows the *boundary*:

> *"The Turtles were given rules for two different but related breakout systems we called System 1 and System 2. **We were given full discretion to allocate as much of our equity to either system as we wanted.** Some of us chose to trade all our equity using System 2, some chose to use a 50% System 1, 50% System 2 split, while others chose different mixes."*
([Original Turtle Rules, ch. 4](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

So: **strategy-mix allocation was discretionary; the stop (2N), the unit size (1% per N), the add interval (½N), the exits (10/20-day), and the position limits (4/6/10/12 units) were not.**

---

## Q4.9 Pre-specified rules vs live judgement — and the "discretionary override" problem

### Evidence that CTAs run mechanical exits with an explicit override

The Frontier Fund S-1 (a registered multi-advisor commodity pool) is unusually candid. Verbatim from the filing:

**Quantitative Investment Management (QIM) Global Program:**
> *"QIM employs... risk management procedures that take into account the price, size, volatility, liquidity, and inter-relationships of the contracts traded. On the portfolio level, account risk is monitored on a daily basis to target a specific standard deviation of daily returns. For both the Global Program, this is equivalent to **12% annualized volatility**. During significant draw-downs in equity, QIM reduces market exposure by scaling back the overall leverage."*
> *"The execution of QIM's trading strategy is systematic. All facets of the predictive models, risk management, and trade allocation are fully automated. However, discretion plays a role in the evolution of the trading system over time... The trading is discretionary in that final decisions are made, and **systems occasionally overridden**, based on the full set of information."*
([Frontier Fund S-1, SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY — regulatory filing]**

**Rosetta Capital Management (RCM):**
> *"The Programs utilize a number of trading rules, some of which are applied via computer. The computerized rules generally assist in the assessment of when to enter and exit designated markets and the optimum position size for a participating customer's account. However, **the Programs are not fully automated and are not totally mechanical.** RCM's trading decisions are aided by computer-generated technical analysis but are discretionary based on its assessment of fundamental factors."* **[PRIMARY]**

**The filing's own risk-factor language on what discretion costs:**
> *"Discretionary Decision Making May Result in Missed Opportunities or Losses... the trading advisors often use discretion in selecting contracts and markets to be followed. In exercising such discretion, such trading advisor **may take positions opposite to those recommended by the trading advisor's trading system or signals**... such use of discretion may cause the series to forego profits which it may have otherwise earned had such discretion not been used."* **[PRIMARY]**

**Strategic Ag (discretionary):** *"Strategic Ag believes that the most important attribute to longevity and profitability in today's market is the ability to change. Change does not necessarily mean bullish or bearish, but, increasing or decreasing position size; whether to take profits or let them run; to trade or not to trade..."* **[PRIMARY — this is the counter-account: a discretionary manager stating that exit-mode choice IS the edge]**

**Transtrend (systematic, but with profit-target and stop tools):**
> *"The risk-estimate is trade-based and takes volatility into account. This implies an (internal) risk-evaluation by the applied trading systems, which may lead to adjustments of position sizes during the lifetime thereof. The initial risk evaluation determines the position size at the time of entry. Signaled price behavior may lead to a gradual addition to or reduction of the initial position. Significantly adverse price behavior may lead to a partial or full exit for the (remainder of the) position."*
> *"Entry/Exit Tools: The entry/exit tools may contain both proprietary trend-following and contra-trend elements and include techniques of (dynamic) profit targets and (dynamic) stop levels for individual trades."* **[PRIMARY]**

**Tiverton (discretionary, with a trailing stop):** *"Tiverton will seek to move stop loss exit levels in the direction of the trend, in an attempt to protect a portion of the unrealized profit of the trade."* **[PRIMARY]**

### The override problem, stated by the Turtle document itself

> *"Another problem is the tendency to want to change the rules. Many of the Turtles, in an effort to reduce the risk of trading the system, changed the rules in subtle ways which sometimes had the opposite of the desired effect."*
> *"One member of the first Turtles class, who was fired from the program before the end of the first year... could not face up to the simple fact that his poor performance was due to his own doubts and insecurities, which resulted in his inability to follow the rules."*
([Original Turtle Rules, ch. 8](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

### The counter-evidence: discretion is not automatically bad

- **The Turtles were allowed discretion over system allocation** (see Q4.8). **[PRIMARY]**
- **LeBeau's framework is explicitly discretionary in the *tightening schedule*:** *"We have found that some markets have better trending characteristics than others and we prefer to adjust the trailing stops on a market by market basis so there is no universal formula that we would recommend."* ([LeBeau](https://idoc.pub/documents/chuck-lebeau-trailing-stops-chandelier-strategy-mwl183q7zj4j)) **[PRIMARY]**
- **Bellafiore's Reasons2Sell is a judgment-triggered list, not a formula** (see Q4.4). **[PRIMARY]**

### Answer to Q4's headline question

| Decision | Mechanical or discretionary? | Evidence |
|---|---|---|
| Position size | **Mechanical** (formula) | Turtle unit formula; Winton; QIM; Transtrend; Van Tharp |
| Initial stop distance | **Mechanical** (2N, ATR multiple, structure level chosen ex ante) | Turtle ch. 5; LeBeau; StockCharts ATR/Chandelier |
| Stop *tightening* schedule | **Mixed** — formula in trend systems, market-by-market discretion in LeBeau's discretionary framework | LeBeau; Transtrend "dynamic stop levels" |
| Loss exit execution | **Rigidly mechanical**; the non-negotiability is the point | *"These stops were non-negotiable exits. If a particular commodity traded at the stop price, then the position was exited; each time, every time, without fail."* ([Turtle, ch. 5](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) |
| Profit exit / trade management | **The discretion zone.** Turtle: 10/20-day breakout, mechanical, and explicitly the hardest rule to obey. Discretionary desks: tape-reading, targets, "Reasons2Sell", time stops | Turtle ch. 6; SMB; Tiverton; Strategic Ag |
| Whether to override | Formally permitted at several named CTAs; framed as a risk in the fund's own filings | QIM; RCM; Frontier Fund risk factors |

**Bottom line:** *entries are the most controllable and therefore the easiest part; sizing and initial stops are formulas; the profit exit is where judgement lives — and the systematic literature's consistent message is that discretionary profit-taking is the main channel through which a positive-expectancy system is degraded.* LeBeau's summary is the cleanest: *"success in trading depends on our exits and not our entries."*

---

# PART Q5 — POSITION SIZING IS A FORMULA, NOT A JUDGEMENT

## Q5.0 The headline finding

Every primary source located — the Turtle rules, Winton's regulatory disclosure, QIM, Transtrend, Carver, Van Tharp, Thorp, the AQR/Man AHL/CFM research — describes position size as the output of an explicit formula driven by (a) account equity, (b) a risk budget, and (c) an estimate of the instrument's volatility or stop distance. In no primary source is size described as a directional judgement. Winton's filing states the separation in one sentence:

> *"Owing to the leverage inherent in futures trading, **position sizes are set according to Winton's expectation of the risk that such positions will provide rather than the amount of capital required to fund such positions.**"*
([Frontier Fund S-1, SEC EDGAR, quoting Winton's Diversified Program disclosure](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY — regulatory filing]**

---

## Q5.1 The core formula: size as a function of stop distance

**The canonical identity (risk-normalised sizing):**

```
Position Size (units) = (Account Equity x Risk% per trade) / |Entry Price - Stop Price|
```

Equivalently, in the volatility form when the stop is volatility-scaled:

```
Position Size = (Account Equity x Risk%) / (k x ATR x Point Value)     [stop = k x ATR]
```

**Primary-source instantiations:**

| Source | Formula as stated | Flag |
|---|---|---|
| **Turtle rules (2003)** | `Unit = (1% of Account) / Dollar Volatility`, where `Dollar Volatility = N x Dollars per Point`; stop at 2N → 2% risk per unit | [PRIMARY] — [source](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view) |
| **MQL5 Turtle implementation** | `Position size per unit = (Account Equity x 0.01) / N_dollars`; `lots = risk_amt / (n_dollars x 2.0)` for the 2N stop | [SECONDARY] — [source](https://www.mql5.com/en/articles/23448) |
| **Van Tharp** | *"Position Sizing Risk. It's your total risk when you multiply 1R times the number of shares that you purchase."* With 1R = entry − stop, this is exactly `Size = Risk$ / (Entry − Stop)` | [PRIMARY] — [source](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/) |
| **Transtrend** | *"The initial risk evaluation determines the position size at the time of entry."* | [PRIMARY] — [source](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm) |
| **Winton** | *"position sizes are set according to Winton's expectation of the risk that such positions will provide"* | [PRIMARY] — [source](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm) |

**Van Tharp's own worked example of 1R** (25% trailing stop on a stock): *"Your initial risk should be 25% of the entry price... With a trailing stop, every time the stock makes a higher close you should raise your stop so that a 25% drop from the current level gets you out."* ([Van Tharp Institute](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/)) **[PRIMARY]**

---

## Q5.2 Fixed-fractional vs fixed-ratio sizing

### Fixed fractional (percent-risk)

The formula in Q5.1 *is* fixed-fractional sizing: risk a constant fraction `f` of **current** equity per trade. Because equity compounds, position size compounds automatically.

- Ralph Vince is the canonical reference for the fixed-fractional framework and for optimal *f* — see [*Portfolio Management Formulas* / *The Mathematics of Money Management*]. The most substantial *primary-source description* located is the Turtle unit formula, which is fixed-fractional with `f = 1%` per unit and `f = 2%` per trade. **[PRIMARY]**
- Elder's variant: the **2% rule** (never risk more than 2% of capital on any single trade) and the **6% rule** (never lose more than 6% of capital in any one month) — see Q5.3. **[SECONDARY via IncredibleCharts]**

### Fixed ratio (Ryan Jones)

Ryan Jones' *The Trading Game* introduced **fixed-ratio** sizing, in which the number of contracts is increased as a function of *accumulated profit*, not of equity percentage. The standard formulation:

```
Increase from n to (n+1) contracts when:
    Account Profit accumulated since the last increase >= Delta x n

i.e.  Required equity gain to go from n to n+1 contracts = Delta x n
```
where `Delta` is a user-chosen dollar amount (frequently quoted as $5,000 in worked examples).

**Honest flag:** the algebraic form above is widely reproduced but I was **not able to fetch a primary or near-primary statement of it during this pass**. What I could verify from the sources fetched is the *Turtle analogue* — the Turtles' equity-taper rule: *"The Turtles were instructed to decrease the size of the notional account by 20% each time we went down 10% of the original account. So if a Turtle trading a $1,000,000 account was ever down 10%, or $100,000, we would then begin trading as if we had a $800,000 account... If we lost another 10%... we were to reduce the account size by another 20% for a notional account size of $640,000."* ([Original Turtle Rules, ch. 3](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]** — this is the opposite design philosophy: de-risking on drawdown rather than requiring profit accumulation before increasing size.

**Criticism of fixed-ratio:** the standard critique is path-dependence — required equity gain scales with the number of units, so the sizing schedule is a function of the sequence of results, and it behaves like a martingale under stress. I could not locate a primary-source statement of this critique; flag as **[FOLKLORE pending a source]**.

---

## Q5.3 Risk-per-trade norms: what is actually documented

| Norm | Verifiable source? | Flag |
|---|---|---|
| **Turtle: max 2% risk per trade, 1 unit = 1N = 1% of equity** | Yes — verbatim in the original rules | **[PRIMARY]** — [source](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view) |
| **Turtle: alt "Whipsaw" stop = ½N = ½% per unit, still ≤2% for 4 units** | Yes | **[PRIMARY]** |
| **Turtle: portfolio caps 4 / 6 / 10 / 12 units** (≈4%, 6%, 10%, 12% aggregate risk) | Yes | **[PRIMARY]** |
| **~1% of portfolio risk per trade** | Yes — Van Tharp: *"For most of you that should equal about 1% of your portfolio."* | **[PRIMARY]** — [source](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/) |
| **Elder's 2% rule (per trade) + 6% rule (per month)** | Secondary description of *Come Into My Trading Room*: *"NEVER LOSE MORE THAN 6 PERCENT OF YOUR CAPITAL IN ANY ONE MONTH."* | **[SECONDARY]** — [source](https://www.incrediblecharts.com/trading/6_percent_rule.php) |
| **"Professionals risk 0.5–2% per trade"** | **Not verified.** No primary source located. This appears to be a generalisation from the Turtle 2% cap and the Elder/Van Tharp 1–2% retail norms. | **[FOLKLORE]** — say so explicitly |
| **Prop-firm daily loss limits** | Yes — FTMO's own published rules | **[PRIMARY]** — below |

### Prop firms: published limits and the per-trade risk they imply

FTMO's own trading-rules page states its objectives: *"With a $100,000 simulated account, reach $10,000 Profit Target without exceeding 5% ($5,000) Maximum Daily Loss or 10% ($10,000) Maximum Loss."* ([FTMO Trading Rules](https://ftmo.com/en/trading-rules/)) **[PRIMARY — the firm's own rules page]**

**Implied per-trade risk:** with a 5% daily loss limit, a trader who takes 3 losing trades in a day must keep average risk ≤ ~1.67% per trade; an 8-trade day implies ≤ ~0.63% per trade. A 10% maximum overall loss with a typical 3-consecutive-loss streak tolerance implies ≤ ~3.3% per trade *in the limit*, and materially less in practice. **This arithmetic is my own derivation from FTMO's published limits, not FTMO's stated guidance** — flag as **[DERIVED]**, and note that firms also enforce consistency rules that constrain sizing further (see FTMO's rules page).

**Second-order point:** prop-firm limits are *portfolio-level* hard stops (daily and total), which is the same structure as Elder's 6% monthly rule and the Turtles' equity-taper rule. The pattern across all three: **the binding constraint is on aggregate drawdown, and per-trade risk is derived downward from it.**

---

## Q5.4 Volatility targeting and risk-parity sizing (CTAs and multi-asset funds)

### The base formula

```
Target Notional Exposure = (Target Volatility / Instrument Volatility) x Capital
```
equivalently, in position-size form:

```
Position Size = Capital x (Target Vol / Instrument Vol) x (Signal / Leverage Cap)
```

### Evidence that this is real, named-desk practice

**Winton Capital Management — from its own CFTC/SEC disclosure document:**
> *"Each day, the Trading System sets volatility parameters (known as the 'instantaneous forecast standard deviation') for each position held in the portfolio... **The Diversified Program's long-term annualized volatility target is currently approximately 10%** (please note that if applied to a managed account, a fully-funded managed account is assumed)."*
> *"In order to achieve the long-term risk target the correlation between different markets is estimated by the Diversified Program, and is employed in the calculation of the overall level of gearing which is reset on a daily basis. The level of gearing typically used by the Diversified Program is normally determined by **targeting a long-term daily standard deviation of less than 1 percent of the value of the portfolio as a whole**."*
([Frontier Fund S-1, SEC EDGAR](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY — regulatory filing]**

**Quantitative Investment Management (QIM):** *"On the portfolio level, account risk is monitored on a daily basis to target a specific standard deviation of daily returns. For both the Global Program, this is **equivalent to 12% annualized volatility**. During significant draw-downs in equity, QIM reduces market exposure by scaling back the overall leverage."* ([ibid.](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

**The Frontier Fund's own structure — the 10–15% target-vol band:** *"Each series permits its trading advisor(s) to trade assets allocated to it using notional equity (funds allocated to an account in excess of actual funds deposited in the account) **in order to keep each series' annual return volatility between 10% and 15%**."* ([ibid.](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

**Transtrend:** *"the composition of a fully diversified portfolio includes Financial Instruments on interest rates... Transtrend determines the (relative) proportions of all components within the portfolio on basis of the signaled correlation over the course of time."* Standard vs Enhanced Risk Profile: the Enhanced profile is *"approximately 1.5 times the leverage of the Standard Risk Profile"*, with *"average margin commitments generally also approximate 10% of the nominal account size"*. ([ibid.](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

> **So the "10–15% annualised target volatility for CTAs" claim, which is often asserted loosely, IS substantiated by three named managers' own regulatory filings, with Winton at ~10%, QIM at 12%, and the Frontier Fund's own mandate band at 10–15%.** This upgrades the claim from folklore to **[PRIMARY]**.

### The academic case

**Moreira & Muir, *"Volatility-Managed Portfolios"*, NBER WP 22208 (2016), published *Journal of Finance* 72(4), 1611–1644 (2017):**
> *"Managed portfolios that take less risk when volatility is high produce **large alphas, substantially increase factor Sharpe ratios**, and produce large utility gains for mean-variance investors. We document this for the market, value, momentum, profitability, return on equity, and investment factors in equities, as well as the currency carry trade. **Volatility timing increases Sharpe ratios because changes in factor volatilities are not offset by proportional changes in expected returns.**"*
([NBER WP 22208](https://wwwtest.nber.org/papers/w22208); [JF version](https://onlinelibrary.wiley.com/doi/10.1111/jofi.12513)) **[PRIMARY — academic]**

**Man Group / AHL, *"The Impact of Volatility Targeting"* (30 May 2018):**
> *"**Volatility targeting** seeks to counter the fluctuations in volatility: It leads to leveraging a portfolio at times of low volatility, and scaling down exposures at times of high volatility. This approach targets a constant level of volatility, rather than a constant notional exposure."*
> *"Volatility targeting improves the Sharpe ratio of 'risk assets' (equities and credit), and that of 'balanced' and 'risk parity' portfolios that have a substantial allocation to these risk assets... In contrast, for bonds, currencies, and commodities the impact on the Sharpe ratio is negligible."*
> *"Volatility targeting reduces the likelihood of extreme returns for all asset classes. Importantly, 'left-tail' events tend to be less severe, as they typically occur at times of elevated volatility, when a target-volatility portfolio has a scaled-down notional exposure."*
([Man Group](https://www.man.com/insights/the-impact-of-volatility-targeting)) **[PRIMARY — named desk]**

Note the honest limitation AHL states: *"we investigate the impact of volatility targeting across more than 60 assets, with daily data from 1926"* — and the effect is concentrated in risk assets, negligible in bonds/FX/commodities.

### Rob Carver's practitioner sizing formula (the fullest public specification)

Carver (former AHL, author of *Systematic Trading*) gives the full position-sizing stack:

```
position as % of capital =
      (instrument forecast / average instrument forecast)
    x (target risk / instrument risk)
    x instrument weight
    x IDM
```
where IDM is the **Instrument Diversification Multiplier** — *"the factor applied to positions to account for the correlation between trading subsystems (i.e. the trading strategies we run for each instrument and the returns they product, not the underlying instrument returns)."* And:

```
Expected risk = target risk x (relative forecast strength) x (relative correlation factor)
```
([Rob Carver, *Should I run my trading system at a fixed expected volatility target?*, 6 Oct 2020](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html)) **[PRIMARY — named practitioner, former AHL]**

Carver runs his own system at a **25% annualised** risk target (higher than a typical CTA because it is his personal account, not a fund), and reports that forcing a *fixed* ex-ante risk target each day *"dramatically reduces performance"* — Sharpe fell from 0.93 to 0.64 — because it throws away the information in aggregate forecast strength. ([ibid.](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html)) **[PRIMARY]**

**Carver on the vol-targeting vs positive-skew trade-off** (directly relevant to Q4's "let winners run" debate): removing vol targeting from a 37-market trend system raised monthly skew from +1.08 to +2.46 but cut Sharpe from 0.92 to 0.569, worsened kurtosis from 5.28 to 33.0, and worsened the max loss from −32.6% to −55.6%. Post-1981 (excluding outliers), Sharpe 0.78 vs 0.52. His conclusion: *"vol targeting does indeed seem to remove some of the positive skew from trend following... But the cost is terribly high: about a third of our Sharpe Ratio!"* ([Rob Carver, *Vol Targeting and Trend Following*, 9 Jul 2018](https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html)) **[PRIMARY]**

**This is the key tension:** vol targeting (mechanical sizing) *reduces* the fat right tail that trend following is prized for, but raises risk-adjusted return. Sizing is mechanical; the *choice of target* is a policy decision with a real trade-off.

### CFM on trend-following convexity

CFM's technical note *"Making fat right tails fatter with trend following… most of the time"* (Nov 2018) documents the convexity/skew properties and warns that they are horizon-dependent: the daily skew of a 100-day trend strategy *"has evolved over time from being positive to negative"*, while the longer-horizon convexity remains. ([CFM](https://www.cfm.com/making-fat-right-tails-fatter-with-trend-following-most-of-the-time/)) **[PRIMARY — named quant fund]**

---

## Q5.5 Kelly, fractional Kelly, and optimal *f*

### The Kelly formula (Thorp's formulation)

Edward O. Thorp, *"The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market"* (1997, presented at the 10th International Conference on Gambling and Risk Taking, Montreal):

> *"In both these settings, we explore the use of the Kelly criterion, which is to **maximize the expected value of the logarithm of wealth** ('maximize expected logarithmic utility'). The criterion is known to economists and financial theorists by names such as the 'geometric mean maximizing portfolio strategy', maximizing logarithmic utility, the growth-optimal strategy, the capital growth criterion, etc."*
> *"The author initiated the practical application of the Kelly criterion by using it for card counting in blackjack."*
> *"[Kelly] has helped the author to make a thirty year total of 80 billion dollars worth of 'bets'."*
([Thorp, paper index page with chapter PDFs](https://sites.oxy.edu/lengyel/M330/thorp/paper.htm)) **[PRIMARY — named practitioner/academic]**

**Standard Kelly formulas** (the binary form is the classic; the continuous form is the trading form):

```
Binary bet:        f* = (b x p - q) / b  =  edge / odds
                   p = probability of winning
                   q = 1 - p
                   b = odds received on the wager (net odds per unit staked)

Continuous / stock: f* = (mu - r) / sigma^2
                   mu = expected return, r = risk-free rate, sigma^2 = variance
```
**Source flag:** the abstract, chapter list and framing above are verified from Thorp's paper index page. The specific algebraic forms are the standard textbook statements of the criterion and are consistent with Thorp's chapters 2–3 and 7; **the individual chapter PDFs were not fetched in this pass** — re-verify the exact notation against [ch3.pdf](https://sites.oxy.edu/lengyel/M330/thorp/ch3.pdf) and [ch7.pdf](https://sites.oxy.edu/lengyel/M330/thorp/ch7.pdf) before publication. Mark as **[PRIMARY — index verified; chapter algebra pending]**.

### Why practitioners use half-Kelly or less

The arguments, as documented:

1. **Estimation error.** Kelly assumes the edge and the distribution are *known*. In trading they are estimated from a finite sample. Overestimating the edge means betting a multiple of Kelly, which is catastrophic — betting *2x* Kelly gives zero long-run growth, and beyond that, negative growth. ([FOLKLORE-adjacent — this is a standard result but I did not fetch a primary statement of the "2x Kelly ⇒ zero growth" boundary in this pass.])
2. **Drawdown.** Full Kelly produces very large drawdowns. Van Tharp's critique (via Kinlay): Kelly and optimal *f* *"make unrealistic assumptions of one kind or another, such as, for example, that there are only two outcomes, rather than the multiple possibilities from a trading strategy, or considering only the outcome of a single trade, rather than a succession of trades (whose outcome may not be independent). Just as with the Martingale, these techniques will often produce unacceptably large drawdowns."* ([Kinlay, 23 Sep 2018](https://jonathankinlay.com/2018/09/)) **[PRIMARY — named quant author]**
3. **Fractional Kelly preserves Sharpe and scales growth.** Betting a fraction `c` of the Kelly optimum scales the growth rate and the volatility roughly proportionally, leaving the Sharpe ratio approximately unchanged while reducing drawdown. ([Standard result; not verified against a fetched primary source in this pass.])

**Honest note:** I was unable to fetch a primary-source statement from Thorp on his *personal* use of fractional Kelly or on the specific "why half-Kelly" argument. The claim that practitioners use half-Kelly is consistent with the sources but **the specific quotes should be sourced to Thorp's chapter 9 (*My Experience with the Kelly Approach*)** before publication. Mark as **[PARTIALLY VERIFIED]**.

### Optimal *f* and its critique

Ralph Vince's **optimal f** maximises long-run geometric growth by choosing the fraction of capital risked per trade from the historical distribution of trade results, anchored on the *worst historical loss*.

**The critique, as documented:**

> *"The most fundamental problem with Optimal f is embedded in its own calculation: the formula is anchored to the largest historical loss a system has produced. But that figure is only known after the fact... you never know the worst possible loss [so this is unrealistic]."*
> *"Vince makes no attempt to adjust for choppiness, volatility, or how well or poorly the system is trading in the current environment."*
> *"How Trend Following Money Management Actually Works... As volatility rises, position sizes contract. As volatility falls, they can expand. As a losing streak develops, total exposure decreases to protect capital. As profits accumulate, positions can grow in proportion. This ongoing adjustment to real conditions is precisely what Optimal f, as Vince presents it, does not do."*
([TurtleTrader — *Optimal F by Ralph Vince: Money Management Theory vs. Trend Following Reality*](https://www.turtletrader.com/optimal-f/)) **[SECONDARY/FOLKLORE — Michael Covel's site; the second quoted passage is attributed only to "one experienced trader"; commercially motivated. Treat as an informed critique, not as evidence.]**

The stronger, independent critique is Kinlay's (above), which is a named quant author writing on his own site rather than a vendor page: **[PRIMARY]**.

**The constructive alternative** that the same sources point to is exactly the Turtle scheme: volatility-normalised sizing with a fixed percentage risk per unit, which is *adaptive to current conditions* rather than calibrated to a historical worst case.

---

## Q5.6 Portfolio-level sizing: risk budgeting and correlation

### Portfolio risk

```
Portfolio variance (ex-ante):  sigma_p^2 = w' S w
   w = vector of position weights (% of capital)
   S = covariance matrix (instrument vols + correlations)

Portfolio volatility:          sigma_p = sqrt(w' S w)
```
Both Carver and the CTA filings use exactly this:
- Carver: *"The expected risk of my portfolio today will be **wSw'**, where **w** are the current weights (basically position as % of capital) and **S** is my current estimate of the covariance matrix composed of instrument standard deviations and the correlation between instrument returns."* ([Carver, 6 Oct 2020](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html)) **[PRIMARY]**
- Winton: *"the correlation between different markets is estimated by the Diversified Program, and is employed in the calculation of the overall level of gearing which is reset on a daily basis."* ([SEC filing](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

### The Instrument Diversification Multiplier (Carver's correlation adjustment)

Carver's IDM is the exact mechanism by which per-position risk is converted into portfolio risk under correlation:

> *"if you normally trade two subsystems (say US 10 year and S&P 500) with correlation between subsystems of zero then your IDM will be equal to square root of 2: 1.414... imagine that for some reason your system has a long average sized position in US 10 years, and a short average sized position in S&P 500 futures, and also that the correlation between these two instruments is -1. A quick calculation shows that the expected risk here will be 2.82 times the average. If the correlation was zero, then the expected risk would be twice the average; and if the correlation was +1 then the expected risk would be zero."*
([Carver, 6 Oct 2020](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html)) **[PRIMARY]**

His proposed portfolio-level risk adjustment:
```
f = S_target / S_portfolio          (scale all positions to hit the risk target)
f* = 1 / (relative correlation factor)   (correct for correlation only, keep forecast information)
```
He tested both: the simple `f` cut Sharpe from 0.93 to 0.64; the `f*` version left Sharpe at 0.87 vs 0.93 baseline. **[PRIMARY]**

### The Turtle system's correlation-adjusted limits

The Turtles' 4 / 6 / 10 / 12 unit ladder is a coarse, rules-based risk budget that is explicitly correlation-aware:

> *"Closely Correlated Markets – For markets that were closely correlated there could be a maximum of 6 Units in one particular direction... Closely correlated markets include: heating oil and crude oil; gold and silver; Swiss franc and Deutschmark; TBill and Eurodollar, etc."*
> *"Loosely Correlated Markets – For loosely correlated markets, there could be a maximum of 10 Units in one particular direction."*
([Original Turtle Rules, ch. 3](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

Max aggregate risk at the extremes: 12 units × 2% = 24% if every stop were hit simultaneously. The document itself recounts a real episode: *"The Turtles were loaded long in interest rate futures: Eurodollars, TBills and Bonds. The losses the following day were enormous. In some cases, 20% to 40% of account equity was lost in a single day. But these losses would have been correspondingly higher without the maximum position limits."* **[PRIMARY]** — a candid admission that position limits bound but do not eliminate correlated tail risk.

### The Frontier Fund's cross-manager structure

At the fund level, the same principle recurs: the managing owner allocates across CTAs and *"Each series permits its trading advisor(s) to trade assets allocated to it using notional equity... in order to keep each series' annual return volatility between 10% and 15%."* ([SEC filing](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

**Risk parity:** the underlying idea (weight assets so each contributes equal risk, `RC_i = w_i (Sw)_i / sigma_p`) traces to Qian's work at Bridgewater. **I was not able to fetch a primary source for Qian's *Risk Parity Portfolios* (2005) in this pass** — flag as **[UNVERIFIED — needs a source]**.

---

## Q5.7 Sizing kept mechanical and separated from the directional view

This is the sub-question with the cleanest evidence base. Four independent mechanisms appear in primary sources:

### 1. The formula contains no directional input

The Turtle unit formula takes only equity, N, and contract specs as inputs. There is no term for conviction, view, or thesis. ([Original Turtle Rules, ch. 3](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view)) **[PRIMARY]**

### 2. Risk-based, not capital-based, sizing — explicitly separated

Winton: *"position sizes are set according to Winton's expectation of the risk that such positions will provide **rather than the amount of capital required to fund such positions**."* ([SEC filing](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

### 3. Automated risk control running independently of the signal

Beach Horizon (a named CTA in the same filing): *"Beach Horizon employs a rigorous, systematic trading model that is implemented using a fully automated state-of-the-art computer system. **Risk management controls are applied by the system hundreds of times a day to constantly adjust to the targeted level of risk.**"* ([ibid.](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

Cantab: *"Cantab takes a strictly quantitative approach to all aspects of trading. **Strategy selection, portfolio construction, execution and risk control are all specified by algorithmic and systematic processes.**"* ([ibid.](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

### 4. Forecast strength is a *separate* multiplier on top of the risk formula

Carver's decomposition makes the separation explicit: conviction enters as `(forecast / average forecast)`; risk enters as `(target risk / instrument risk)`. These multiply. The risk term is mechanical; the forecast term is the (possibly discretionary or model-based) directional component. ([Carver, 6 Oct 2020](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html)) **[PRIMARY]**

And critically, Carver's empirical finding is that **you should not let a mechanical risk overlay override the directional signal**: forcing a fixed ex-ante risk target destroyed performance (Sharpe 0.93 → 0.64) because it discarded aggregate forecast strength. The correct overlay corrects only for correlation (`f* = 1/relative correlation factor`). **[PRIMARY]**

### 5. The override risk runs the other way

The Frontier Fund's own risk factors warn that a *discretionary* manager may *"take positions opposite to those recommended by the trading advisor's trading system or signals"* — i.e. the danger to the mechanical sizing/risk layer comes from the directional desk, not the reverse. ([SEC filing](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm)) **[PRIMARY]**

**Honest gap:** I did **not** find a primary source describing the specific institutional separation *"risk manager sets the size, PM sets the direction"* as a stated organisational rule at a bank or hedge fund (e.g. a risk-policy document, a regulator's description of an independent risk function, or a named risk manager describing the split). The evidence above establishes the *functional* separation (size is computed from risk, not from view); the *organisational* separation is asserted in the industry but not verified here. Flag as **[PARTIALLY VERIFIED]**.

---

# WHAT I COULD NOT FIND

Items I searched for and could **not** verify with a fetched primary source. These should be either sourced properly or cut before publication.

1. **The specific ATR-multiple conventions** ("1.5x ATR for day trading, 2x for swing, 3x for position"). Only the *range* (~1.5x–4x) is documented, by LeBeau.
2. **Any quantification of breakeven stops.** "Move to breakeven at +1R" is ubiquitous in retail content and appears in **no** primary source I could find with data attached. It is absent from the Turtle system, from LeBeau's Chandelier framework, and from Carver's writing.
3. **The Ryan Jones fixed-ratio formula** stated in a primary or near-primary source (the `Delta x n` rule). Widely reproduced; not verified.
4. **The Van Tharp "random entry + Chandelier exit" study numbers.** LeBeau cites it as existing in *Trade Your Way to Financial Freedom*; the original study's results were not fetched.
5. **Odean (1998)'s headline statistics** (PGR/PLR ratio, December effect, the annual performance penalty). Only abstracts/records were fetched, not the full text. Same for Shefrin & Statman (1985)'s four theoretical elements.
6. **A rigorous quantification of "the majority of profit comes from a small number of trades."** Directionally supported by CFM's convexity work and the Turtle exit arithmetic; the specific percentage claim was not found in a mainline source.
7. **A quantitative study of time stops** — documented as practice (SMB, QuantMetrics) but no evidence of edge found.
8. **Thorp's own statements on fractional Kelly** and the specific "why half-Kelly" argument. The paper index and abstract were fetched; chapters 3, 7 and 9 were not.
9. **The "2x Kelly ⇒ zero growth" boundary** in a fetched primary source.
10. **Qian / Bridgewater's *Risk Parity Portfolios* (2005)** — the founding risk-parity document was not fetched.
11. **The claim "professionals risk 0.5–2% per trade."** No primary source. The verified anchors are Turtle 2% max, Van Tharp ~1%, Elder 2%/6%. **This claim should be labelled FOLKLORE or replaced with the sourced numbers.**
12. **"Risk manager sets size, PM sets direction" as a stated organisational rule.** The functional separation is well documented; the organisational one is not.
13. **Any evidence on scaling out at 2R specifically.** The tests found used generic profit targets, not the specific "1R/2R/3R thirds" convention.
14. **CFM's own position-sizing formula** (as opposed to their skew evidence). Their published technical note covers convexity, not sizing arithmetic.
15. **Winton's per-trade or per-position risk limit.** Winton's filing discloses the *portfolio* vol target (~10% annualised, <1% daily) but not a per-trade risk number.

---

# SOURCE INVENTORY

**Primary — named practitioner / desk / author / academic / regulatory filing**

| Source | URL | Used for |
|---|---|---|
| The Original Turtle Trading Rules (2003, OriginalTurtles.org) | [Google Drive PDF](https://drive.google.com/file/d/1Slj01mFv0Jf3_SdJGuVPOdxVLLXUt5yF/view) | N, unit sizing, 2N stops, whipsaw stops, unit limits, 10/20-day exits, equity taper, rule-following psychology |
| Frontier Fund S-1 (SEC EDGAR, 2012) — Winton, QIM, Transtrend, Tiverton, RCM, Beach Horizon, Cantab, Strategic Ag | [SEC](https://www.sec.gov/Archives/edgar/data/1450720/000119312512515036/d455510ds1.htm) | Winton 10% vol target; QIM 12% vol target + discretionary override; Frontier 10–15% band; Transtrend trade-based risk sizing; Tiverton trailing stop; RCM discretion; Strategic Ag |
| Chuck LeBeau, *Trailing Stops — The Chandelier Exit* | [idoc.pub](https://idoc.pub/documents/chuck-lebeau-trailing-stops-chandelier-strategy-mwl183q7zj4j) | Chandelier formula, 2.5–4 ATR initial, tightening schedule, Tharp random-entry study |
| Chuck LeBeau, *Taking Control* | [StockFetcher forums](https://forums.stockfetcher.com/forums/General-Discussion/Taking-Control-by-Chuck-LeBeau/61642) | "entries are the easy part"; control asymmetry losses vs profits; 25x25 system |
| Chuck LeBeau, *Trading Messages from Mars* | [Capitalogix](https://capitalogix.com/2015/10/chuck-lebeau-on-the-importance-of-exits) | "success in trading depends on our exits and not our entries"; ATR/ADX in stops |
| Van K. Tharp, *Risks in Trade: Understanding All* | [Van Tharp Institute](https://vantharpinstitute.com/understanding-all-the-risks-in-a-trade-by-van-k-tharp-ph-d/) | 1R definition; "1R x shares... about 1% of your portfolio" |
| Jonathan Kinlay, *Money Management — the Good, the Bad and the Ugly* | [jonathankinlay.com](https://jonathankinlay.com/2018/09/) | Expectancy, R, SQN formula and its reduction to Sharpe; critique of Kelly and optimal f |
| Kaminski & Lo, *When Do Stop-Loss Rules Stop Losses?* | [S-WoPEc](https://swopec.hhs.se/sifrwp/abs/sifrwp0063.htm) | Stops add value only under momentum; 50–100bp/month in stop-out periods |
| Moreira & Muir, *Volatility-Managed Portfolios* | [NBER w22208](https://wwwtest.nber.org/papers/w22208) | Vol timing raises Sharpe ratios and produces large alphas |
| Man Group / AHL, *The Impact of Volatility Targeting* | [Man](https://www.man.com/insights/the-impact-of-volatility-targeting) | Vol targeting improves Sharpe for risk assets; reduces left tail; negligible for bonds/FX/commodities |
| CFM, *Making fat right tails fatter with trend following… most of the time* | [CFM](https://www.cfm.com/making-fat-right-tails-fatter-with-trend-following-most-of-the-time/) | Trend-following positive skew / convexity; horizon dependence |
| AQR, Hurst/Ooi/Pedersen, *A Century of Evidence on Trend-Following Investing* | [AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) | Trend strategy profitable 1880–present |
| Rob Carver, *Should I run my trading system at a fixed expected volatility target?* | [qoppac](https://qoppac.blogspot.com/2020/10/should-i-run-my-trading-system-at-fixed.html) | Position-sizing formula, IDM, portfolio risk wSw', risk-overlay tests |
| Rob Carver, *Vol Targeting and Trend Following* | [qoppac](https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html) | Vol targeting vs skew/Sharpe trade-off, with numbers |
| Edward O. Thorp, *The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market* | [oxy.edu index](https://sites.oxy.edu/lengyel/M330/thorp/paper.htm) | Kelly = maximise E[log wealth]; 30-year, $80bn of bets |
| Mike Bellafiore / SMB Capital, *The Time Stop*, *Reasons2Sell* | [SMB](https://www.smbtraining.com/blog/the-time-stop-an-example-in-yum) | Time stops; Reasons2Sell; pre-specified but judgment-triggered exits |
| Adrian Reid, *Trend Following Profit Targets: Do They Work?* | [Enlightened Stock Trading](https://enlightenedstocktrading.com/trend-following-profit-targets-do-they-work/) | Partial profit-taking reduced return in every parameter combination tested |
| Dean Hoffman, *Using Partial Exits And Position Sizing To Improve Performance Results* | [TradingMarkets](https://tradingmarkets.com/recent/Using_Partial_Exits_And_Position_Sizing_To_Improve_Performance_Results-659906) | Pro-partial-exit backtest (confounded by increased contract count) |
| FTMO Trading Rules | [FTMO](https://ftmo.com/en/trading-rules/) | 5% max daily loss, 10% max loss, 10% profit target |
| Shefrin & Statman (1985) | [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.1985.tb05002.x) | Disposition effect — origin paper |
| Odean (1998) | [Wiley](https://onlinelibrary.wiley.com/doi/full/10.1111/0022-1082.00072) | Disposition effect — empirical test |
| Grinblatt-adjacent / Taiwan aggregate study | [Wiley](https://onlinelibrary.wiley.com/doi/10.1111/j.1468-036X.2007.00367.x) | Disposition effect outside the US |

**Secondary / reference**

| Source | URL | Used for |
|---|---|---|
| StockCharts ChartSchool — Chandelier Exit | [link](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit.md) | 22-period / 3x ATR packaged formula |
| StockCharts ChartSchool — Parabolic SAR | [link](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/parabolic-sar.md) | Wilder PSAR formula, AF rules, constraints |
| StockCharts ChartSchool — ATR Trailing Stops | [link](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/atr-trailing-stops.md) | Generic ATR trailing stop, 2x–3x multipliers |
| cTrader Help — Parabolic SAR | [link](https://help.ctrader.com/indicators/zh/built-in/trend/parabolic-sar/) | Generalised SAR formula, AF 0.02/0.02/0.2 |
| NinjaTrader — Managing Trade Risk Using Probabilities | [link](https://ninjatrader.com/futures/blogs/managing-trade-risk-using-probabilities/) | MAE definition and use for stop placement |
| IncredibleCharts (Colin Twiggs) — Elder's 6 Percent Rule | [link](https://www.incrediblecharts.com/trading/6_percent_rule.php) | 2%/6% rules; structural stop placement |
| TurtleTrader (Michael Covel) — Original Turtle Rules page | [link](https://www.turtletrader.com/rules/) | Donchian weekly rule; Dennis on rules vs judgements |
| TurtleTrader — Market Wizards quotes | [link](https://www.turtletrader.com/market-quotes/) | Attributed Seykota / PTJ / Hite / Kovner / Basso / Saliba / McKay / Schwartz / Sperandeo quotes |
| MQL5 — Automating the Original Turtle Trading Rules | [link](https://www.mql5.com/en/articles/23448) | Independent implementation confirming Turtle formulas |

**Folklore / not relied upon**

| Source | Why excluded |
|---|---|
| turtletrader.com *Optimal F* page | Vendor page; the key critique quotes are attributed only to "one experienced trader" |
| Various SEO guides on "breakeven stops", "ATR multiples by trading style", "1–2% rule" | No traceable primary source |
| quantstrategy.io partial-exit backtests | SEO content farm; not used |
| TradingView indicator descriptions | Not used as evidence |
