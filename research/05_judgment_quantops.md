# Q7 — What Genuinely Requires Human Judgment, and Algorithmic/Quant Desk Operational Process

**Research brief — Section 05**
Compiled from live web research. Every claim below carries an inline link to a URL actually fetched during this research, plus a source-quality flag.

**Quality-flag key**
- `[PRIMARY - regulator/broker doc/named practitioner/academic]` — the claim comes from a regulator, an exchange/broker's own document, a named practitioner speaking/writing in their own voice, or peer-reviewed/academic work.
- `[SECONDARY - journalism/summary]` — the claim comes from a journalist, trade publication, law firm, or a third party summarising primary material.
- `[FOLKLORE - unsourced blog assertion/SEO content]` — the claim comes from vendor marketing, SEO content, or an anonymous blog with no traceable primary source. **These are recorded because practitioners read them, not because they are verified.**

**Method caveat.** `web_fetch` refused `application/pdf` content, so PDFs were retrieved with `curl` and text-extracted locally (pypdf). SEC.gov returned HTTP 403 (rate-limit threshold) on direct fetch, so Rule 15c3-5 was read from the Cornell LII mirror of the e-CFR. Several sources were unreachable and are listed in "WHAT I COULD NOT FIND".

---

## PART A — Q7: WHAT GENUINELY REQUIRES HUMAN JUDGMENT?

### A1. Regime change recognition — "is this a new regime or noise?"

The single most useful primary admission comes from a broker's own quantitative desk. Morgan Stanley's QSI group states plainly that structural breaks in correlation are real, persistent, and *hard to time*:

> "Correlations have empirical evidence of memory effects and structural breaks — Timely identification of such breaks is difficult. Idea is to apply regime switching models to short-term correlation with the objective of identifying a clearer picture of changes in structure by viewing correlation in 'state space'."
> — Morgan Stanley, *Quantitative Solutions and Innovations (QSI): Introduction and Overview*, Sept 2014, pp. 17–20 `[PRIMARY - broker doc]`
> https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf

Note what QSI does with that admission: it *systematises* the detection (regime-switching models on short-term correlation, exit carry when P(regime 2) > 90%) but leaves the choice of overlay and the interpretation to the investor. `[PRIMARY - broker doc]` https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf

A named practitioner — George Patterson, a veteran quant macro investor — frames regime validity as a *daily* judgment call layered on top of an otherwise systematic process:

> "You always have to ask yourself...are the assumptions behind the model still valid? Has there been a regime shift in the data? That's the kind of thing we worry about every day when we're using models."
> — George Patterson, *Top Traders Unplugged* ALO35, "Why Macro Investing Is Becoming More Systematic" `[PRIMARY - named practitioner (via podcast transcript notes)]`
> https://pod.wave.co/podcast/top-traders-unplugged-8b7faedb-66ff-4bb4-a1c3-f8cafa3b56b4/alo35-why-macro-investing-is-becoming-more-systematic-ft-george-patterson

The same episode explicitly separates regime detection from "unknown unknowns", where it says judgment is required (COVID being the example). `[PRIMARY - named practitioner (via podcast transcript notes)]` https://pod.wave.co/podcast/top-traders-unplugged-8b7faedb-66ff-4bb4-a1c3-f8cafa3b56b4/alo35-why-macro-investing-is-becoming-more-systematic-ft-george-patterson

**The systematic counter-case: trend following is deliberately built not to detect regimes.** Hutchinson & O'Brien's study, "Is This Time Different? Trend Following and Financial Crises", is summarised as finding that trend following's weakness is concentrated *after* crises, and that the underlying statistical regularity itself breaks down:

> "In our analysis of the underlying markets, our empirical evidence indicates a breakdown in the time series predictability, pervasive in normal market conditions, on which trend following relies."
> — Hutchinson & O'Brien (2014), quoted in Peak Investment Solutions summary `[SECONDARY - summary of academic paper]`
> https://www.peakis.net/2016/10/03/trend-following-works-weakest-financial-crises/

The same summary notes the methodological trap that makes "regime" a judgment call rather than a measurement: "identifying a list of global and regional financial crises is problematic" — the researchers had to borrow crisis lists from *Manias, Panics, and Crashes* and *This Time Is Different*. `[SECONDARY - summary of academic paper]` https://www.peakis.net/2016/10/03/trend-following-works-weakest-financial-crises/

**A CFA Institute piece states the practitioner consensus that regime-*awareness* is achievable while regime-*prediction* is not:**

> "Effective risk management in modern markets demands regime-aware positioning. Not prediction recognition. The distinction matters."
> — CFA Institute Research & Policy Center, *Why Static Portfolios Fail When Risk Regimes Change* `[SECONDARY - professional body commentary]`
> https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/why-static-portfolios-fail-when-risk-regimes-change

The same piece supplies the concrete numbers that make regime detection a live problem rather than an academic one: stocks and bonds declined together for 14 consecutive months in 2022 (31% of trading days), and the 36-month stock–bond correlation spiked to 0.66 by December 2024 against a 20-year average of −0.10. `[SECONDARY - professional body commentary]` https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/why-static-portfolios-fail-when-risk-regimes-change

**The honest tension for the brief:** the CFA piece recommends "quantitative thresholds — not discretionary judgment calls" for regime identification, while simultaneously arguing that the 2020 and 2022 regime breaks each required *opposite* defensive positioning and a portfolio optimised for one "would have been decimated" in the other. `[SECONDARY - professional body commentary]` https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/why-static-portfolios-fail-when-risk-regimes-change

---

### A2. Thesis invalidation — broken vs. merely early

Howard Marks' January 2022 memo *Selling Out* is the most explicit named-practitioner statement that this decision is not systematizable. Its closing line is the money quote:

> "In other words, the decision to trim positions or to sell out entirely comes down to judgment . . . like everything else that matters in investing."
> — Howard Marks, *Selling Out*, Oaktree Capital memo, 13 Jan 2022 `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

Marks gives two — and only two — legitimate analytical triggers for a sale, both of which require a judgment about a *probability* rather than a fact:

> "If your investment thesis seems less valid than it did previously and/or the probability that it will prove accurate has declined, selling some or all of the holding is probably appropriate."
> "Likewise, if another investment comes along that appears to have more promise — to offer a superior risk-adjusted prospective return — it's reasonable to reduce or eliminate existing holdings to make room for it."
> — Howard Marks, *Selling Out* `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

He also names the mechanism — "the discipline of relative selection", attributed to Sidney Cottle — which means a sell decision cannot be evaluated in isolation from what replaces it. `[PRIMARY - named practitioner]` https://www.oaktreecapital.com/insights/memo/selling-out

And he is explicit that position limits resist scientific calculation:

> "there can be legitimate reasons to limit the size of the positions we hold, but there's no way to scientifically calculate what those limits should be."
> — Howard Marks, *Selling Out* `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

Marks also documents the *psychological* pull that makes "broken vs early" hard: "a good deal of selling takes place because people like the fact that their assets show gains, and they're afraid the profits will go away." `[PRIMARY - named practitioner]` https://www.oaktreecapital.com/insights/memo/selling-out

**Klarman's version of the same problem** is that the *purchase* decision is easier than the *sale* because the margin of safety degrades as price rises:

> "Many investors are able to spot a bargain but have a harder time knowing when to sell. One reason is the difficulty of knowing precisely what an investment is worth... As the market price appreciates, however, that safety margin decreases; the potential return diminishes and the downside risk increases. Not knowing the exact value of the investment, it is understandable that an investor cannot be confident in the sell decision as he or she was in the purchase decision."
> — Seth Klarman, *Margin of Safety*, ch. 13, reproduced at Marram Investment Management `[SECONDARY - blog reproducing primary book text]`
> http://www.marramllc.com/blog/pmjar/1679

Klarman rejects mechanical sell rules outright:

> "there is only one valid rule for selling: all investments are for sale at the right price… Decisions to sell, like to buy, must be based upon underlying business value."
> — Seth Klarman, *Margin of Safety*, ch. 13 `[SECONDARY - blog reproducing primary book text]`
> http://www.marramllc.com/blog/pmjar/1679

**Mauboussin supplies the closest thing to a repeatable process** — expectations investing, which converts "is the thesis broken?" into "have expectations changed?":

> "step one is saying, what expectations in terms of value drivers... do we need to achieve to justify today's stock price?... step two then is introducing both historical analysis but also strategic and financial analysis to determine or judge whether that set of expectations is too optimistic, too pessimistic, or about right... And then step three... would be to buy, sell, or hold based on what you found."
> — Michael Mauboussin, Morningstar *The Long View* interview `[PRIMARY - named practitioner]`
> https://dhms8q85tpugt.cloudfront.net/retirement/michael-mauboussin-finding-easy-games

Mauboussin also supplies the base-rate discipline that disciplines the "just early" excuse: in a separate interview he describes appealing to base rates — "how many companies of this size have grown at this rate for this period of time, in history?" — and notes that when a company sits in the far right tail, "it certainly wouldn't be your base case." `[PRIMARY - named practitioner]` https://acquirersmultiple.com/2019/10/ep-32-the-acquirers-podcast-michael-mauboussin-big-decisions-luck-skill-complexity-and-success-in-investing/

**What a multi-manager platform screens for** is the *pre-commitment* to what would break the trade. A Millennium-focused interview guide describes the expected pitch structure:

> "A strong pitch states a clear thesis, a catalyst with a rough timeline, a variant view on where the market has it wrong, and the risks that would break the trade—then holds up when the interviewer pushes on your position sizing."
> — TechInterview.org, *Millennium Management Interview Guide* `[FOLKLORE - SEO/interview-prep content; the "5% rule" and pod counts are unsourced]`
> https://www.techinterview.org/companies/millennium-management-interview-guide/

**I could not find** a named practitioner write-up that gives an explicit, numeric, operational rule for "thesis broken vs. merely early". Every primary source treats it as judgment; the only quasi-mechanical discipline found is base-rate comparison (Mauboussin) and relative-selection opportunity cost (Marks).

---

### A3. Correlation / concentration risk across the book — "8 positions that are really one bet"

**The strongest quantitative statement of the problem** comes from a conference write-up describing correlation research across US equities:

> "the average pairwise daily-return correlation across US equities has nearly tripled - from 5.7% in the 1962-1997 period... to 13.4% from 1998 through 2020, and 15.9% in the 2021 to April 2026 window."
> "that correlation is not static. It is roughly 90% correlated with market volatility itself - meaning correlations spike precisely when investors most need diversification to work. The highest single quarter on record was Q2 2022 at 27.7%. The highest single month came in April 2025 at 36.8%."
> — Opalesque session write-up citing Gelernter and Fang/Jiang/Sun/Yin/Zheng research `[SECONDARY - conference write-up citing academic work]`
> https://www.opalesque.com/714652/In_Name_why_most_portfolios465.html

The same write-up quantifies the collapse in diversifiable risk: 94.3% of equity risk was diversifiable in 1962–1997, 84.1% currently, and "just 63.2% in the April 2025 stress month." `[SECONDARY - conference write-up]` https://www.opalesque.com/714652/In_Name_why_most_portfolios465.html

**The pod-shop failure mode is documented for March 2026** across Citadel, Millennium and Point72:

> "in March, correlations across asset classes spiked, and dispersion—ironically a key source of alpha—became harder to monetize."
> "many pods were exposed to similar macro factors, even if their specific trades differed"
> "The crowded nature of certain trades—particularly in factor-based strategies—meant that unwinding positions could have an outsized impact on market prices."
> "In March, as losses mounted, many firms reduced exposure across their portfolios. This 'de-grossing' process—selling assets to reduce risk—added to market pressure and further exacerbated price movements."
> — HedgeCo.Net, *"March Malaise" Results Are In* `[SECONDARY - trade journalism]`
> https://hedgeco.net/news/04/2026/march-malaise-results-are-in-critical-stress-test-of-the-modern-pod-based-hedge-fund-model.html

This is the clearest articulation of the "8 positions are one bet" problem at platform level: **different trades, same macro factor**. `[SECONDARY - trade journalism]` https://hedgeco.net/news/04/2026/march-malaise-results-are-in-critical-stress-test-of-the-modern-pod-based-hedge-fund-model.html

**A useful quantification of the *hidden* bet** (flagged FOLKLORE but widely repeated in risk writing):

> "A portfolio that appears diversified across 20 positions with 0.35 average correlation effectively becomes a concentrated 5-position portfolio when correlations spike to 0.85."
> — Breaking Alpha, *Tail Risk Hedging in Quantitative Trading Strategies* `[FOLKLORE - vendor/SEO content; the 0.3-0.4 calm / 0.8-0.9 COVID correlation figures it supplies are unsourced]`
> https://breakingalpha.io/insights/tail-risk-hedging-quantitative-trading-strategies

**"Hidden beta" / net-exposure deception.** A fund-structure vendor makes the point that headline exposure numbers conceal the real book:

> "Net exposure is one of the most quoted and least informative numbers in hedge fund reporting. It is useful as a starting point and misleading as a summary. The risk of a long short book sits in the gross, the composition of each leg, and the way the legs behave together in market conditions the manager has not previously encountered."
> "This is why institutional risk reporting goes beyond gross and net and provides decomposition by beta, sector, factor, style, and concentration."
> — CV5 Capital, *Gross Exposure vs Net Exposure* `[FOLKLORE - fund-administration vendor content marketing, though technically substantive]`
> https://www.cv5capital.io/insights/gross-exposure-vs-net-exposure-hedge-funds

**How multi-manager books are read externally** — a 13F analytics vendor describes the correct mental model:

> "Treat the holdings as a hedged, aggregated book where individual positions rarely carry directional meaning, remember that the visible longs are offset by shorts you cannot see... The right mental model is a risk-managed collection of many independent bets — not a portfolio with a point of view."
> — 13F Insight, *Pod Shops and Multi-Manager Platforms* `[FOLKLORE - SEO content, but consistent with the pod structure described elsewhere]`
> https://13finsight.com/learn/pod-shops-multi-manager-platforms-13f

**Crypto correlation regime shifts** were the weakest-evidence area (see "WHAT I COULD NOT FIND"). The only crypto-specific corroboration found was the general basis/funding mechanism described below, plus the March-2026 "correlations across asset classes spiked" line which is not crypto-specific. `[SECONDARY - trade journalism]` https://hedgeco.net/news/04/2026/march-malaise-results-are-in-critical-stress-test-of-the-modern-pod-based-hedge-fund-model.html

---

### A4. Portfolio-level sizing (as opposed to single-trade sizing)

**Conviction-weighted sizing is explicitly a judgment call, and Marks says so.** His reconstructed dialogue with Andrew Marks makes the tension concrete: trimming a winner means "selling something I feel immense comfort with based on my bottom-up assessment and moving into something I feel less good about or know less well (or cash)." `[PRIMARY - named practitioner]` https://www.oaktreecapital.com/insights/memo/selling-out

Marks also rejects portfolio optimisation as a substitute for judgment, on the grounds that the model's inputs are historical while its purpose is forward-looking:

> "The main problem with these models lies in the fact that all the data we have regarding those three parameters relates to the past, but to arrive at the ideal portfolio, the model needs data that accurately describes the future. Further, the models need a numerical input for risk, and I absolutely insist that no single number can fully describe an asset's risk."
> — Howard Marks, *Selling Out* `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

**Vol-targeted sizing has a measurable cost, and it is a named systematic practitioner who quantified it.** Rob Carver, on volatility targeting in trend-following systems:

> "So yes, maybe, there is something in the idea that vol targeting involves giving up some of the positive skew that trend following gives you, at least with monthly data. But the cost is terribly high: about a third of our Sharpe Ratio!"
> "This is the old 'no free lunch in finance' idea... Another word for this is the 'waterbed' effect."
> — Rob Carver, *Vol Targeting and Trend Following* `[PRIMARY - named systematic practitioner, own blog]`
> https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html

This is the cleanest statement of the **conviction-vs-vol-target tension** found: vol targeting is mechanical, improves the risk profile, but costs roughly a third of Sharpe — so whether to run it is a portfolio-level policy judgment, not a signal. `[PRIMARY - named systematic practitioner]` https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html

**Gross/net policy is a discretionary lever.** De-grossing is defined operationally as reducing both legs, and it is triggered by firm-level risk decisions rather than by any single trade:

> "gross exposure comprises the total value of all open long (buy) trades plus the value of all its short (sell) trades... Net exposure meanwhile adds some direction."
> "Ultimately, it means a broad sell-off across the market, beyond whichever highly leveraged tit-for-tat spawned the process."
> — Proactive Investors, on hedge-fund "de-grossing" `[SECONDARY - journalism]`
> https://www.proactiveinvestors.com/companies/news/939874/reddit-stock-buying-insurgency-triggers-hedge-fund-de-grossing--but-what-does-that-even-mean-939874.html

The composition of the gross — not its size — is what determines the stress outcome, and the analytic tools named are stress tests rather than optimisers:

> "A serious manager runs a defined set of stress tests on a periodic basis, discusses the results at the investment and risk committees, and reports the key outcomes in periodic investor materials."
> — CV5 Capital `[FOLKLORE - vendor content marketing]`
> https://www.cv5capital.io/insights/gross-exposure-vs-net-exposure-hedge-funds

**Pod-level capital allocation is rule-based at the platform and judgment-based inside the pod.** The Millennium interview guide (FOLKLORE) describes firm-imposed drawdown limits — "pods that lose more than 5%–7% of allocated capital are typically wound down" — alongside a risk function that "monitor[s] pod exposures, factor sensitivities, and liquidity." `[FOLKLORE - SEO/interview-prep content]` https://www.techinterview.org/companies/millennium-management-interview-guide/

---

### A5. Handling novel events with no historical analogue

**March 2020 — the model itself was the casualty.** Renaissance Technologies disclosed that its risk models failed:

> "The beta models, which help determine portfolio exposure at funds for outside investors, 'in recent volatile markets have not performed as expected,' Renaissance said in a March 30 filing."
> — Bloomberg via Financial Planning, *Renaissance says quant models misfired during March mayhem* `[SECONDARY - journalism reporting a firm filing]`
> https://www.financial-planning.com/articles/renaissance-says-quant-investing-models-misfired-during-march-mayhem

The same piece supplies the single best line in this research for the limits of systematisation, from a former Renaissance executive:

> "Renaissance isn't magic... If Martians invade, they haven't got a model for Martians invading."
> — Nick Patterson, former Renaissance executive `[PRIMARY - named practitioner quoted in press]`
> https://www.financial-planning.com/articles/renaissance-says-quant-investing-models-misfired-during-march-mayhem

It also notes the 2007 precedent — "the quant models were confounded by events they hadn't seen before" — and that Renaissance updated its risk disclosures to add circuit breakers. `[SECONDARY - journalism reporting a firm filing]` https://www.financial-planning.com/articles/renaissance-says-quant-investing-models-misfired-during-march-mayhem

**SNB de-peg, 15 January 2015 — what was mechanical and what was not.** The RBA's minutes, as reported, capture the two-sided verdict on automation:

> "The prevalence of algorithmic and HFT trading on electronic platforms could have contributed to the initial sharp price action in the Swiss franc but also could have enabled the market to stabilize faster than otherwise expected, according to the minutes, which were published by the Reserve Bank of Australia."
> "Algos are both sinners and saints at different times... Generally they add liquidity and improve market depth. At other times, the algos become dysfunctional and disruptive, and their negatives outweigh the positives."
> — Sean Keane, Triple T Consulting, quoted in Traders Magazine `[PRIMARY - named practitioner quoted in trade press; underlying source is RBA minutes]`
> https://www.tradersmagazine.com/departments/technology/robot-trades-inflamed-then-soothed-markets-after-franc-shock/

The **human** failure mode at the moment of the shock was withdrawal of discretion, not automation: "Banks reportedly switched off electronic platforms as quickly as possible after the SNB abolished its limit on the franc, while some dealers temporarily stopped providing price quotes, sapping liquidity." The franc "surged more than 40 percent to as high as 0.8517 per euro within 20 minutes." `[PRIMARY - named practitioner quoted in trade press; underlying source is RBA minutes]` https://www.tradersmagazine.com/departments/technology/robot-trades-inflamed-then-soothed-markets-after-franc-shock/

**LUNA/UST and FTX — the failure was governance and risk framework, not model sophistication.** A Cayman law firm's post-mortem:

> "The fallout revealed major governance failures, such as a lack of segregation between customer and corporate funds, wholly inadequate risk management practices and a culture of poor accountability at the executive level."
> "Terra's algorithmic stablecoin (UST) de-pegged from the US dollar in 2022 triggering a cascade of losses... The alleged governance deficiencies here stemmed from the inherent design of Terra's stablecoin model and an apparent the lack of a sound risk management framework. Terra's collapse showcased the need for VASPs to conduct thorough risk evaluations and stress tests, particularly when dealing with novel financial products or instruments."
> "Poor internal control measures such as inadequate financial reporting, poor liquidity management and asset monitoring deficiencies were all significant factors in the downfall of many virtual asset companies including FTX."
> — Conyers, *The Importance of Sound Corporate Governance for Virtual Asset Service Providers* `[SECONDARY - law firm analysis]`
> https://www.conyers.com/publications/view/the-importance-of-sound-corporate-governance-for-virtual-asset-service-providers-lessons-from-past-failures/

**Crypto venue risk after FTX is now an explicit, mechanical rule** in institutional basis trading:

> "The collapse of FTX in 2022 imposed a permanent change in how institutional funds approach venue exposure. The institutional architecture for managing this risk now combines three elements... Daily reconciliation between exchange-reported positions, custody balances and administrator records. Discrepancies escalate immediately rather than ageing through a weekly cycle."
> — CV5 Capital, *Crypto Basis Trades in Institutional Funds* `[FOLKLORE - vendor content marketing; the operational detail is plausible but unsourced]`
> https://www.cv5capital.io/insights/crypto-basis-trades-institutional-funds

**Synthesis for the brief:** across all four events the *pre-trade mechanical* layer (kill switches, pre-trade limits, cancel-on-disconnect) worked or was irrelevant; what failed was (i) risk-model parameters calibrated on non-crisis data (Renaissance), (ii) human decisions to withdraw from the market (SNB), and (iii) the absence of controls altogether (FTX/LUNA).

---

### A6. Deciding to STAND ASIDE / not trade

**At the institutional level this is a stated philosophy, not a tactical choice.** Oaktree's founding tenet, quoted verbatim in the memo:

> "Because we do not believe in the predictive ability required to correctly time markets, we keep portfolios fully invested whenever attractively priced assets can be bought. Concern about the market climate may cause us to tilt toward more defensive investments, increase selectivity or act more deliberately, but we never move to raise cash."
> — Howard Marks, *Selling Out* `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

Marks' corollary is a direct counter to "stand aside" instincts at the portfolio level:

> "Reducing market exposure through ill-conceived selling – and thus failing to participate fully in the markets' positive long-term trend – is a cardinal sin in investing."
> — Howard Marks, *Selling Out* `[PRIMARY - named practitioner]`
> https://www.oaktreecapital.com/insights/memo/selling-out

He also documents why standing aside is so hard in practice: between 1999 and 2018 the S&P 500 annual return was 5.6%, but "your return would only have been 2.0% if you had sat out the 10 best days (or roughly 0.4% of the trading days), and you wouldn't have made any money at all if you had missed the 20 best days." `[PRIMARY - named practitioner, citing JP Morgan Asset Management data]` https://www.oaktreecapital.com/insights/memo/selling-out

**At the day-trading level, the "sit-out checklist" is a real artefact but the sourcing is weak.** A trading-education site gives a three-flags checklist and a claimed base rate:

> "Run through this checklist every morning before you decide to trade. If you check off three or more items, your sit-out signal is flashing."
> "There's no fixed number, but many experienced traders sit out 30-40% of trading days — roughly 6-8 days per month — when conditions don't match their strategy."
> — DayTradingToolkit, *When to Sit Out Day Trading* `[FOLKLORE - SEO content; the 30-40% figure is unsourced]`
> https://daytradingtoolkit.com/beginners-guide/when-to-sit-out-not-trading

It does at least draw a clean conceptual line between discipline and fear:

> "Sitting out is a planned, criteria-based decision made before you see any specific trade setup. Fear is an emotional reaction to a specific trade you've already identified."
> — DayTradingToolkit `[FOLKLORE - SEO content]`
> https://daytradingtoolkit.com/beginners-guide/when-to-sit-out-not-trading

An exchange education page on the same theme is similarly thin: it lists session-liquidity facts (Asian/London/NY sessions, "the period when the European and US sessions overlap (approximately 1PM–4PM (UTC) typically features the highest liquidity and trading volumes") but offers no primary practitioner evidence. `[FOLKLORE - exchange marketing/education content]` https://www.bybit.global/en/learn/trading/the-power-of-no-trade

**Verdict for the brief:** "stand aside" is well-evidenced as a *stated discipline* at the single-trader level and explicitly *rejected* as a market-timing tool at the institutional level by Oaktree. It should be presented as contested, not as settled best practice.

---

### A7. Discretionary overlay on systematic strategies

The best-documented structure is the **hybrid systematic + discretionary macro CTA**. Willowbridge Associates has run systematic trend programs alongside global-macro discretionary trading since 1988:

> "The core trend following signal provides the systematic foundation. The discretionary macro overlay provides the flexibility to navigate environments where mechanical signals alone may generate false positives or miss structural context that changes how patterns should be interpreted."
> — TurtleTrader, *Willowbridge Associates: Systematic and Discretionary Trend Trading Since 1988* `[SECONDARY - content site describing a named CTA; no direct firm document located]`
> https://www.turtletrader.com/trader-willowbridge/

The same source frames the debate explicitly, which is exactly the framing the brief needs:

> "Pure systematic managers argue that any discretionary intervention introduces the behavioral biases that systematic rules are specifically designed to eliminate. Hybrid managers argue that no mechanical system fully captures structural context, particularly around major economic cycle transitions, and that experienced discretion can improve on the system at those inflection points."
> — TurtleTrader `[SECONDARY - content site]`
> https://www.turtletrader.com/trader-willowbridge/

And it draws the operative distinction between *good* and *bad* discretion:

> "Discretion applied to override a system during a losing period is almost always destructive. Discretion applied to recognize that current market structure falls outside the system's designed parameters is potentially additive."
> — TurtleTrader `[SECONDARY - content site]`
> https://www.turtletrader.com/trader-willowbridge/

George Patterson supplies the practitioner version: models "must remain robust, transparent, and tied to a coherent investment philosophy—especially during 'unknown unknowns' like COVID, where judgment is required." `[PRIMARY - named practitioner (via podcast transcript notes)]` https://pod.wave.co/podcast/top-traders-unplugged-8b7faedb-66ff-4bb4-a1c3-f8cafa3b56b4/alo35-why-macro-investing-is-becoming-more-systematic-ft-george-patterson

**I could not find** any primary source containing a numeric override rate (e.g. "we override the model X% of the time"). See "WHAT I COULD NOT FIND".

---

### A8. Behavioural / psychological judgment calls

**Steenbarger, writing in his own voice, names conviction-sizing and re-entry as the judgment skills that separate winners** — neither of which is a rule:

> "1) A creative way of looking at markets, and a way of creatively resolving conflicting market views; 2) The emotional resilience to re-enter a trade idea after being stopped out, when subsequent action confirms the initial view; 3) The courage to bet large when there is high conviction in an idea; the prudence to control risk when that conviction is lacking; 4) An insatiable desire for self-improvement that builds a deep, internal sense of confidence."
> — Dr. Brett Steenbarger, *What I See Among Many of the Best Traders*, TraderFeed `[PRIMARY - named practitioner, own blog]`
> http://traderfeed.blogspot.com/2009/12/what-i-see-among-many-of-best-traders.html

**A secondary summary of Steenbarger's "three vices" framework** (perfectionism, overconfidence, revenge trading) describes the interventions as behavioural rather than systematic:

> "Perfectionism is addressed by reframing the definition of a good trade from 'winning trade' to 'correctly executed trade'... Overconfidence is addressed by returning to the checklist: does the current setup meet the defined criteria? Not 'does it feel like a good trade?' but 'does it pass the rules?' Revenge trading is addressed by the most direct intervention of the three: step away from the screen."
> — TurtleTrader summary of Steenbarger `[SECONDARY - summary of named practitioner's work]`
> https://www.turtletrader.com/brett-steenbarger5/

**Mark Douglas's "five fundamental truths"** are the canonical probabilistic-mindset framework, and the summary is explicit that the endpoint is *mechanical* rather than discretionary:

> "Truth 1 – Anything can happen. Truth 2 – You don't need to know what is going to happen next to make money. Truth 3 – There is a random distribution between wins and losses for any given set of variables that define an edge. Truth 4 – An edge is nothing more than an indication of a higher probability of one thing happening over another. Truth 5 – Every moment in the market is unique."
> "In conclusion, you are aiming for less emotions and a more mechanical, statistical view of trading."
> — Bookmap summary of Mark Douglas, *Trading in the Zone* `[SECONDARY - summary of primary book]`
> https://bookmap.com/blog/5-truths-of-trading

**Interpretation for the brief:** both Steenbarger and Douglas treat the *end state* as rule-conformance. The "judgment" they describe is the meta-decision to keep following the process — not a set of discretionary trade calls. That is an important distinction: psychological management is not systematizable as a *signal*, but it is systematizable as a *process* (checklists, screen-away rules, correctly-executed-trade definitions). `[PRIMARY - named practitioner, own blog]` http://traderfeed.blogspot.com/2009/12/what-i-see-among-many-of-best-traders.html and `[SECONDARY - summary]` https://turtletrader.com/brett-steenbarger5/

---

### A9. THE COUNTER-ARGUMENT: how much "judgment" is illusory?

This is the most important honesty section of the brief. The evidence that discretionary judgment is largely unverifiable is strong and comes from primary academic/named sources.

**Kahneman's "illusion of skill" claim, in his own words (book excerpt):**

> "The results resembled what you would expect from a dice-rolling contest, not a game of skill."
> "Our message to the executives was that, at least when it came to building portfolios, the firm was rewarding luck as if it were skill. This should have been shocking news to them, but it was not."
> "The illusion of skill is not only an individual aberration; it is deeply ingrained in the culture of the industry. Facts that challenge such basic assumptions—and thereby threaten people's livelihood and self-esteem—are simply not absorbed."
> — Daniel Kahneman, *Thinking, Fast and Slow*, excerpted at Business Insider `[SECONDARY - publication reproducing primary book text]`
> https://www.businessinsider.com/daniel-kahneman-on-wealth-management-2012-12

The low-validity-environment mechanism is stated in the same excerpt: "This is particularly true of statistical studies of performance, which provide base-rate information that people generally ignore when it clashes with their personal impressions from experience." `[SECONDARY - reproducing primary book text]` https://www.businessinsider.com/daniel-kahneman-on-wealth-management-2012-12

Additional Kahneman formulations, from a quote compilation (flagged accordingly):

> "Although professionals are able to extract a considerable amount of wealth from amateurs, few stock pickers, if any, have the skill needed to beat the market consistently, year after year."
> "Traders apparently lack the skill to answer this crucial question, but they appear to be ignorant of their ignorance."
> — Daniel Kahneman, via LibQuotes compilation `[FOLKLORE - quote aggregator; quotes appear verbatim in Thinking, Fast and Slow but attribution is not independently verified here]`
> https://libquotes.com/daniel-kahneman/quotes/skill

**Tetlock's Expert Political Judgment** — the design and the result:

> "Tetlock recruited 284 experts from a variety of fields... Tetlock asked the experts to make roughly 28,000 predictions estimating the probability of future events over a nineteen year period from 1984 to 2003."
> "The results were embarrassing; monkeys throwing darts would have done better than the experts. Those experts with the biggest media profile were particularly bad forecasters."
> "Hedgehogs, in Tetlock's terminology, are those experts that confidently look at events in terms of one big idea... But it is hedgehogs, who dominate the media when it comes to forcefully predicting the future; and they are most often wrong."
> — Interamerican Institute for Democracy, summarising Tetlock (2005) `[SECONDARY - think-tank summary of academic work]`
> https://www.intdemocratic.org/en/why-experts-almost-always-get-it-wrong-2.html

Note the direct relevance: the "one big idea" hedgehog is structurally the same failure mode as a discretionary macro trader with a dominant thesis, and the "fox" (many small ideas, probabilistic, willing to admit error) is the systematic/ensemble posture. `[SECONDARY - think-tank summary]` https://www.intdemocratic.org/en/why-experts-almost-always-get-it-wrong-2.html

**SPIVA: the base rate for active management.** For US large-cap equity:

> "In the 2025 scorecard, 79% of actively managed large-cap U.S. equity funds underperformed the S&P 500 for the year, worse than the 65% underperformance rate reported for 2024."
> "The methodology adjusts for survivorship bias — the tendency for underperforming funds to be closed or merged away, which would otherwise flatter the surviving funds' average track record."
> — FTMarketWatch, summarising S&P Dow Jones Indices SPIVA `[SECONDARY - summary of S&P DJI data]`
> https://ftmarketwatch.com/research/spiva-active-vs-passive-funds.html

Longer-horizon and non-US figures from a separate report on the same scorecard:

> "Underperformance rates for global equity managers also increased for longer terms, reaching a whopping 95 per cent over a 15-year period."
> "Over a 15-year span, 85 per cent of active funds fell short of the benchmark" (Australia equity general).
> — Investor Daily, reporting SPIVA `[SECONDARY - journalism]`
> https://www.investordaily.com.au/active-managers-struggle-against-top-heavy-market-performance/

The same piece gives the mechanism that makes the base rate worse in some regimes: "When fewer stocks outperform, it becomes increasingly difficult for managers to identify them" — 72% of S&P World constituents underperformed the index in 2024. `[SECONDARY - journalism]` https://www.investordaily.com.au/active-managers-struggle-against-top-heavy-market-performance/

**The "paradox of skill" is the strongest steelman of the quant side, and it comes from a named practitioner who is sympathetic to discretionary investors.** Mauboussin:

> "if everybody is completely perfectly skilled at the same level, then the outcomes are going to appear to be essentially random, a coin toss. So, that's the idea of the paradox of skill is to say that in areas that are very competitive, very skillful, and very uniform skill, the results are going to appear to be random, even though there's an enormous amount of skill going into things in the first place."
> — Michael Mauboussin, Morningstar *The Long View* `[PRIMARY - named practitioner]`
> https://dhms8q85tpugt.cloudfront.net/retirement/michael-mauboussin-finding-easy-games

Mauboussin also flags the relevant measurement problem: "we look at the standard deviation of alpha, candidly, and that had been trending down really since the 1960s." `[PRIMARY - named practitioner]` https://dhms8q85tpugt.cloudfront.net/retirement/michael-mauboussin-finding-easy-games

**The trend-following / systematise-everything argument** is that discretionary intervention has a measurable price. Carver's vol-targeting result (≈one third of Sharpe given up by *not* running a mechanical risk rule) is the concrete version. `[PRIMARY - named systematic practitioner]` https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html

**Net honest summary for the brief:** the counter-argument is not that judgment never matters — it is that (a) in competitive, low-validity environments, outcomes look random even when skill is present (paradox of skill), (b) ex-post narrative cannot distinguish skill from luck without a base rate, and (c) the measured base rate for discretionary active management is bad in a way that survivorship-adjusted data makes worse, not better. Any claim that a particular discretionary judgment "worked" is therefore unfalsifiable in a single instance and must be judged against base rates.

---

## PART B — ALGORITHMIC / QUANT DESK OPERATIONAL PROCESS

### B1. Pre-trade checks — what an automated trading system validates before sending an order

#### B1.1 Regulatory baseline: SEC Rule 15c3-5 (Market Access Rule)

Rule 15c3-5 requires broker-dealers with market access to "establish, document, and maintain a system of risk management controls and supervisory procedures reasonably designed to manage the financial, regulatory, and other risks of this business activity." `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

**Financial controls (15c3-5(c)(1))** must be reasonably designed to:
- "Prevent the entry of orders that exceed appropriate pre-set credit or capital thresholds in the aggregate for each customer and the broker or dealer and, where appropriate, more finely-tuned by sector, security, or otherwise by rejecting orders if such orders would exceed the applicable credit or capital thresholds" `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5
- "Prevent the entry of erroneous orders, by rejecting orders that exceed appropriate price or size parameters, on an order-by-order basis or over a short period of time, **or that indicate duplicative orders**." `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

That last clause is the regulatory basis for **duplicate-order detection** and **price/size collars**. `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

**Regulatory controls (15c3-5(c)(2))** must be reasonably designed to:
- "Prevent the entry of orders unless there has been compliance with all regulatory requirements that must be satisfied on a pre-order entry basis"
- "Prevent the entry of orders for securities for a broker or dealer, customer, or other person if such person is restricted from trading those securities"
- "Restrict access to trading systems and technology that provide market access to persons and accounts pre-approved and authorized by the broker or dealer"
- "Assure that appropriate surveillance personnel receive immediate post-trade execution reports that result from market access"
`[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

**Governance:** controls must be "under the direct and exclusive control of the broker or dealer"; there must be an annual review of effectiveness; and "The Chief Executive Officer (or equivalent officer)... shall, on an annual basis, certify that such risk management controls and supervisory procedures comply with paragraphs (b) and (c) of this section." `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

Note the SEC's own small-entity compliance guide for the rule could not be fetched (HTTP 403) — see "WHAT I COULD NOT FIND". `[PRIMARY - regulator, unreachable]` https://www.sec.gov/files/rules/final/2010/34-63241-secg.htm

#### B1.2 EU baseline: MiFID II RTS 6 (Commission Delegated Regulation (EU) 2017/589)

Article 15(1) requires **all four** of these pre-trade controls on order entry, for all financial instruments `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589:

| Control | Regulatory wording |
|---|---|
| **Price collars** | "which automatically block or cancel orders that do not meet set price parameters, differentiating between different financial instruments, both on an order-by-order basis and over a specified period of time" |
| **Maximum order values** | "which prevent orders with an uncommonly large order value from entering the order book" |
| **Maximum order volumes** | "which prevent orders with an uncommonly large order size from entering the order book" |
| **Maximum messages limits** | "which prevent sending an excessive number of messages to order books pertaining to the submission, modification or cancellation of an order" |

Additional RTS 6 requirements that map directly onto a real pre-trade stack `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589:

- **All orders count toward limits, immediately:** "An investment firm shall immediately include all orders sent to a trading venue into the calculation of the pre-trade limits referred to in paragraph 1." (Art. 15(2))
- **Repeated automated execution throttle:** "An investment firm shall have in place repeated automated execution throttles which control the number of times an algorithmic trading strategy has been applied. After a pre-determined number of repeated executions, the trading system shall be automatically disabled until re-enabled by a designated staff member." (Art. 15(3))
- **Capital-linked risk limits, dynamically adjusted:** "An investment firm shall set market and credit risk limits that are based on its capital base, its clearing arrangements, its trading strategy, its risk tolerance, experience and certain variables... The investment firm shall adjust those market and credit risk limits to account for the changing impact of the orders on the relevant market due to different price and liquidity levels." (Art. 15(4))
- **Permissioning and threshold blocking at multiple levels:** "An investment firm shall automatically block or cancel orders from a trader if it becomes aware that that trader does not have permission to trade a particular financial instrument... Controls shall be applied, where appropriate, on exposures to individual clients, financial instruments, traders, trading desks or the investment firm as a whole." (Art. 15(5))
- **Exception/escalation path:** "An investment firm shall have procedures and arrangements in place for dealing with orders which have been blocked by the investment firm's pre-trade controls but which the investment firm nevertheless wishes to submit." (Art. 15(6)) — i.e. a *documented* override route rather than an ad-hoc one.
- **Kill functionality (Art. 12):** "An investment firm shall be able to cancel immediately, as an emergency measure, any or all of its unexecuted orders submitted to any or all trading venues to which the investment firm is connected ('kill functionality')." Unexecuted orders include those from "individual traders, trading desks or, where applicable, clients", and the firm "shall be able to identify which trading algorithm and which trader, trading desk or, where applicable, which client is responsible for each order."

#### B1.3 Industry practice: FIA Best Practices for Automated Trading Risk Controls and System Safeguards (July 2024)

This is the most operationally concrete document found. Its organising principle:

> "Localized pre-trade risk controls, not credit controls, should be the primary tools used to prevent inadvertent market activity due to unauthorized access, system failures and errors."
> — FIA, *Best Practices For Automated Trading Risk Controls And System Safeguards*, July 2024, §1 `[PRIMARY - industry association]`
> https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

Controls documented, with FIA's own operational detail `[PRIMARY - industry association]` https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf:

- **§1.1 Maximum Order Size** — "commonly referred to as 'fat-finger' limits. Errors may be prevented by rejecting the order in the case of a limit breach. This risk control should be applied when a new order is submitted or an existing order is modified." Critically: "**Systems should prevent orders from being placed in cases where no order size limits have been set for an instrument.**" Limits should differ by instrument type (futures, options, spreads) and by venue.
- **§1.2 Maximum Intraday Position** — must evaluate "both current positions and working orders... such that limits would not be breached if that order is filled, even though it may not be immediately executable." FIA warns this is "considered simple pre-trade risk limits as opposed to credit limits since an accurate picture of start-of-day positions is difficult to derive in a timely fashion across multiple execution channels" and should be treated as "a 'speed bump' to prevent accidental overtrading and, as such, should be employed with appropriate post-trade risk controls." Also: "Authorized staff independent of trading activities should manage the process whenever possible to avoid conflicts."
- **§1.3 Price Tolerance** — "the maximum amount an individual order's limit price may deviate from a reference price, such as the instrument's current market price, and is typically applied on orders generated from an automated trading system before the order is sent to the exchange."
- **§1.4 Cancel-On-Disconnect (COD)** — exchange service that on loss of connectivity "initiates a best-effort attempt to cancel all resting orders for the disconnected session." Cancellation is at session granularity so other sessions stay live. FIA notes it should be *optional* because for some participants cancelling "adds to risk in such a situation", and that pass-through of customer cancel requests through a broker "is typically unsupported."
- **§1.5 Kill Switches** — "a control that, when activated, immediately disables all trading activity for a particular participant or group of participants, typically preventing the ability to enter new orders and cancelling all working orders. It also may allow for risk-reducing orders while preventing risk-increasing orders." Crucially for the human-in-the-loop section: "kill switches offer just one of many different types of risk controls... **only invoked based on a qualitative decision taken as a last resort when other actions have failed or may not be feasible.** In an environment where adequate pre-trade risk controls are implemented at all appropriate levels... a kill switch may ultimately be considered redundant."

Also documented: **repeated automated execution limits** (§3.2), **exchange message programs** (§3.3), **message throttles** (§3.4) and **self-match prevention** (§3.5) `[PRIMARY - industry association]` https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

**Testing:** §5.1 covers exchange-based conformance testing, and FIA frames the whole control set as applicable to newer technologies: the practices "apply to both existing technologies and evolving ones, such as artificial intelligence (AI)." `[PRIMARY - industry association]` https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

---

### B2. Execution algorithms — and how desks choose between them

#### B2.1 The standard taxonomy and its benchmarks

CFA Institute's curriculum reading states the classification and, importantly, the **selection logic** `[PRIMARY - professional body curriculum]` https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution:

> "Inputs affecting trade strategy selection include the following types: order related, security related, market related, and user based."
> "Managers seeking short-term alpha will use pre-trade benchmarks, such as the arrival price, when they wish to transact close to current market prices (greater trade urgency)."
> "Managers without views on short-term price movements who wish to participate in volumes over the execution horizon typically use an intraday benchmark, such as VWAP or TWAP."
> "Managers of index funds or funds whose valuation is calculated using closing prices typically select the closing price post-trade benchmark to minimize fund risk and tracking error."
> "Execution algorithms can be classified into the following types: **scheduled, liquidity seeking, arrival price, dark aggregators, and smart order routers**."

**So the answer to "when do desks choose which algo?" is: it is driven by the benchmark the PM is being measured against, which is itself driven by urgency and by whether the strategy has short-term alpha.** That is a *rules table keyed on benchmark choice*, not on market conditions alone. `[PRIMARY - professional body curriculum]` https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution

A clear secondary rendering of the same decision table `[FOLKLORE - educational content, but consistent with CFA/Morgan Stanley]` https://openalgo.in/quant/execution-algorithms:

| Algo | Benchmark / goal | Best when |
|---|---|---|
| TWAP | Plain time average | "No reliable volume forecast; want a steady, predictable footprint" |
| VWAP | The day's VWAP | "Large order over a full session, judged against VWAP" |
| POV | Fixed share of volume | "Want impact proportional to flow; flexible on finish time" |
| IS / Almgren-Chriss | The decision price | "Urgency matters; trade off impact against timing risk explicitly" |

The same source states the underlying trade-off formally: "It models execution cost as the sum of two opposing terms: market impact, which rises the faster you trade, and timing risk (price volatility over the execution window), which rises the slower you trade." `[FOLKLORE - educational content]` https://openalgo.in/quant/execution-algorithms

The identical mapping appears in crypto-specific guidance, which matters because the brief covers crypto venues `[FOLKLORE - vendor academy content]` https://coinroutes.com/cn/academy/crypto-execution-algorithms-twap-vwap-pov-is/:

> "TWAP spreads an order evenly across a defined time window... Best when: you want to minimize impact and have a clear time horizon, without trying to predict volume. Tradeoff: because it ignores volume, TWAP may trade too much during quiet periods or too little during active ones."
> "VWAP aims to match the volume-weighted average price over a period by trading more when the market is more active... Best when: you want to execute in line with the day's natural volume distribution."
> "POV ties execution to a target share of live market volume — for example, 'be 10% of volume.'... Best when: you want to control footprint relative to the market rather than to the clock."
> "Implementation Shortfall (IS) minimizes the gap between the price when the order arrived (the decision price) and the final average execution price... Best when: the decision price is your benchmark and you want to manage impact and timing risk together."

**Crypto exchange-native execution:** Kraken ships TWAP as a native order type — evidence that these algos are now exchange primitives, not only broker products:

> "TWAP takes one large parent order and breaks it into smaller child orders, spaced out over a window you set from 1 minute to 30 days. Each child order goes to market as an IOC (immediate-or-cancel) order at the best bid or best ask, and every child order still respects the limit price you set on the parent order."
> "TWAP is an execution tool, not a trading strategy or a market signal. It won't tell you when to trade, only how to work an order once you've decided to place it."
> — Kraken Blog, *TWAP orders are now available on Kraken Pro* `[PRIMARY - exchange documentation]`
> https://blog.kraken.com/product/pro/twap-orders-now-available

#### B2.2 The actual selection mechanism at a desk: the "algo wheel"

The most concrete answer found to "how is the algo choice made — a rules table?" is that large buy-side desks **systematise the choice itself** via an algo wheel. FlexTrade's product announcement, quoting its CEO, describes both the problem and the mechanism `[PRIMARY - vendor product announcement with named executive]` https://mondovisione.com/media-and-resources/news/flextrade-launches-flexalgowheel-next-generation-intuitive-interface-for-syst-2017515/:

> "an important, yet repetitive role of any trader is to select the right broker and algorithm based on a multitude of factors, such as **order characteristics, portfolio manager instructions, market volatility and relative contribution to risk in the portfolio**."
> "FlexAlgoWheel enables buy-side firms to configure a systematic and quantifiable decision matrix through an intuitive point-and-click interface that dynamically selects the optimal broker and algorithm."
> "Firm-wide, data-driven, unbiased consistency in the algorithm selection criteria will become the norm."
> Features listed include "Real-time and historical TCA" and "A feedback mechanism via TCA to optimize the broker and algorithm selection process."

So the operational answer is a **hybrid**: a configured decision matrix (rules) selects the broker/algo, TCA feeds back to update the matrix, and the PM's instruction is an explicit input. `[PRIMARY - vendor product announcement with named executive]` https://mondovisione.com/media-and-resources/news/flextrade-launches-flexalgowheel-next-generation-intuitive-interface-for-syst-2017515/

Morgan Stanley's QSI deck confirms the same framing from a broker's side, listing "TCA & Execution Benchmarks" and "Algorithmic Trading" as the components of "Retaining Alpha" `[PRIMARY - broker doc]` https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf

---

### B3. Transaction Cost Analysis (TCA) — what is measured and how it feeds back

#### B3.1 Metrics

CFA Institute states the standard decomposition `[PRIMARY - professional body curriculum]` https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trading-costs-and-electronic-markets:

> "The implementation shortfall method measures the total cost of implementing an investment decision by capturing **all explicit and implicit trading costs**. It includes the **market impact costs, delay costs, as well as opportunity costs**."
> "The VWAP method of estimating transaction costs compares average fill prices to average market prices during a period surrounding the trade. It tends to **produce lower transaction cost estimates than does implementation shortfall because it often does not measure the market impact of an order well**."

And in the companion reading: "The implementation shortfall measure is the standard for measuring the total cost of the trade. IS compares a portfolio's actual return with its paper return (where transactions are based on decision price)." `[PRIMARY - professional body curriculum]` https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution

So the four metric families are: **effective spread**, **VWAP**, **implementation shortfall (with market-impact / delay / opportunity-cost decomposition)**, and **arrival-price** benchmarks. `[PRIMARY - professional body curriculum]` https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trading-costs-and-electronic-markets

**Broker-side TCA framework** — Morgan Stanley's QSI describes an FX TCA framework that provides `[PRIMARY - broker doc]` https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf:

> "a) calculate transaction costs and market impact **ex-ante (pre-trade)**; b) identify the **fair-value benchmark price** against which the effective price received should be measured; c) **attribute transaction costs to key underlying market factors** such as order size, depth of market liquidity, order flows and volatility; and d) generate comprehensive TCA reports on every transaction done with Morgan Stanley and other counterparties"

It also notes the buy-side obligation under CFA Trade Management Guidelines: "every manager must have an appropriate systematic process in place, to audit, analyze and evaluate the quality of execution being received and attribute the costs being charged to investors in each asset class and security managed." `[PRIMARY - broker doc]` https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf

#### B3.2 Industry standardisation

FIX Trading Community maintains a "TCA Best Practices for Equities (v2)" guideline with the stated goal "to provide the industry with specific guidelines to promote TCA standardization." `[PRIMARY - industry standards body]` https://fixtrading.org/download-category/guidelines/ — see https://fixtrading.org/download-category/guidelines/ for the guidelines index.

Trade press confirms FIX's work is aimed at equities TCA standardisation and cross-venue cost determination. `[SECONDARY - trade journalism]` https://www.thetradenews.com/fix-tackles-tca-standardisation-and-hft/

#### B3.3 Regulatory reporting: MiFID II RTS 27 / RTS 28

Article 27(6) of MiFID II "requires Investment Firms to make public the top five execution venues", supplemented by RTS 28 specifying "the content and format of this information". `[SECONDARY - regulatory note (MFSA)]` https://www.mfsa.mt/wp-content/uploads/2024/02/The-European-Securities-and-Markets-Authority-ESMA-Clarifies-Certain-Best-Execution-Reporting-Requirements-under-MiFID-II.pdf

The regime has since been curtailed. ESMA proposed "a streamlined, less detailed and more user-friendly RTS 27 reporting framework", reducing venue best-execution indicators "down to seven key areas" (total monetary value of transactions, median monetary transaction value, fees for a median transaction, bid-offer spread for a median transaction, access to further information on costs, speed of execution, and total number of market makers designated per instrument). `[SECONDARY - trade journalism]` https://www.thetradenews.com/esma-proposes-changes-to-burdensome-mifid-ii-best-execution-reporting-requirements/

Subsequently the RTS 27 reporting obligation was deleted and RTS 28 reporting was deprioritised by ESMA supervisory action from 13 February 2024. `[SECONDARY - regulatory note (MFSA)]` https://www.mfsa.mt/wp-content/uploads/2024/02/The-European-Securities-and-Markets-Authority-ESMA-Clarifies-Certain-Best-Execution-Reporting-Requirements-under-MiFID-II.pdf

**Feedback loop:** TCA → algo selection is stated explicitly in the algo-wheel source ("A feedback mechanism via TCA to optimize the broker and algorithm selection process") and in the educational framing that "TCA measures every real execution against VWAP and implementation shortfall, so you can see where you leak and feed that back into the choice of algo. TCA is to execution what backtesting is to strategy." `[PRIMARY - vendor product announcement with named executive]` https://mondovisione.com/media-and-resources/news/flextrade-launches-flexalgowheel-next-generation-intuitive-interface-for-syst-2017515/ ; `[FOLKLORE - educational content]` https://openalgo.in/quant/execution-algorithms

---

### B4. Backtest-to-live process, validation and deployment

#### B4.1 The regulatory answer is unusually specific: RTS 6 Articles 5–11

This is the most detailed codified "backtest-to-live" process found, and it is a legal requirement in the EU `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589:

- **Art. 5 — General methodology, senior-management sign-off.** "Prior to the deployment or substantial update of an algorithmic trading system, trading algorithm or algorithmic trading strategy, an investment firm shall establish clearly delineated methodologies to develop and test such systems, algorithms or strategies." And: "A person designated by the senior management of the investment firm shall authorise the deployment or substantial update..." The methodology must ensure the system "does not behave in an unintended manner", "does not contribute to disorderly trading conditions, continues to work effectively in stressed market conditions and, where necessary under those conditions, allows for the switching off of the algorithmic trading system."
- **Art. 6 — Conformance testing** against the venue's or DMA provider's system, triggered inter alia "prior to the deployment or material update"; must verify the algorithm "interacts with the trading venue's matching logic as intended" and "adequately processes the data flows downloaded from the trading venue."
- **Art. 7 — Separate testing environment.** Testing must occur "in an environment that is separated from its production environment and that is used specifically for the testing and development of algorithmic trading systems and trading algorithms." The definition of "production environment" is given in full (software/hardware used by traders, order routing, market data, dependent databases, risk control systems, data capture, analysis, post-trade processing).
- **Art. 8 — Controlled deployment (i.e. canary).** "Before deployment of a trading algorithm, an investment firm shall set predefined limits on: (a) the number of financial instruments being traded; (b) the price, value and numbers of orders; (c) the strategy positions; and (d) the number of trading venues to which orders are sent."
- **Art. 9 — Annual self-assessment and validation report.** The risk management function draws up the validation report and must "involve staff with the necessary technical knowledge"; the report "shall be audited by the firm's internal audit function... and be subject to approval by the investment firm's senior management"; deficiencies must be remedied.
- **Art. 10 — Stress testing.** "running high messaging volume tests using the highest number of messages received and sent by the investment firm during the previous six months, multiplied by two" and the equivalent for trade volume. Tests must not affect the production environment.
- **Art. 11 — Management of material changes.** "any proposed material change to the production environment related to algorithmic trading is preceded by a review of that change by a person designated by senior management", with depth "proportionate to the magnitude of the proposed change", and changes communicated to traders, compliance and risk.

#### B4.2 Model risk management: SR 11-7 / OCC 2011-12

The US supervisory guidance (Federal Reserve SR 11-7, issued jointly with the OCC as Bulletin 2011-12, 4 April 2011) supplies the governing concepts `[PRIMARY - regulator]` https://www.federalreserve.gov/boarddocs/srletters/2011/sr1107a1.pdf:

- **"Effective challenge"** is the guiding principle: "critical analysis by objective, informed parties who can identify model limitations and assumptions and produce appropriate changes. Effective challenge depends on a combination of incentives, competence, and influence." And: "Incentives to provide effective challenge to models are stronger when there is greater separation of that challenge from the model development process."
- **Model risk scales with complexity and reach:** "Model risk increases with greater model complexity, higher uncertainty about inputs and assumptions, broader use, and larger potential impact."
- **Aggregate model risk is a portfolio problem:** "Aggregate model risk is affected by interaction and dependencies among models; reliance on common assumptions, data, or methodologies; and any other factors that could adversely affect several models and their outputs at the same time." This is the model-risk analogue of the "8 positions are one bet" problem.
- **Model inventory and documentation:** policies "should require maintenance of detailed documentation of all aspects of the model risk management framework, including an inventory of models in use, results of the modeling and validation processes, and model issues and their resolution."
- Framework sections are: Model Development, Implementation, and Use; **Model Validation**; and Governance, Policies, and Controls.

#### B4.3 Walk-forward analysis and overfitting controls

Definition and acceptance thresholds `[FOLKLORE - educational glossary; thresholds are conventions, not standards]` https://tradingstrategy.ai/glossary/walk-forward-analysis:

> "Walk-forward analysis (WFA) is a backtest validation methodology that tests a trading strategy by repeatedly optimising parameters on an in-sample window, then evaluating performance on the immediately following out-of-sample window, and rolling both windows forward through time... It is widely considered the gold standard for parameter validation in quantitative trading."
> "A key output of walk-forward analysis is the walk-forward efficiency (WFE): the ratio of annualised out-of-sample return to annualised in-sample return. **A WFE above 50% is generally considered acceptable**... Below 50%, the strategy is likely overfit."
> "Common splits include 2–5 years in-sample with 3–12 months out-of-sample. The number of parameters being optimised also matters: more parameters require longer in-sample windows and produce lower walk-forward efficiency."

A second treatment makes the meta-overfitting trap explicit `[SECONDARY - financial media opinion]` https://cdn2.benzinga.com/Opinion/26/05/52497471/walk-forward-analysis-in-trading-what-it-is-how-it-works-and-when-its-truly-useful:

> "if we test multiple combinations and then select the one that produces the best equity curve, we are effectively optimizing not only the strategy, but also the validation process itself. As a result, the out-of-sample loses much of its meaning, and a more subtle form of overfitting is introduced – one that is just as dangerous, but less obvious than parameter optimization."
> "a strategy validated using Walk Forward Analysis already exhibits more realistic behavior during the testing phase: more frequent drawdowns and a less linear equity curve, but one that more closely resembles what is later observed in live trading."

**Formal overfitting statistics** exist and are named in an open-source implementation citing the primary academic papers `[SECONDARY - software documentation citing academic papers]` https://raw.githubusercontent.com/plaintext-capital/pypbo/master/README.md:

- Bailey, Borwein, Lopez de Prado & Zhu, *The Probability of Backtest Overfitting* (2015), Journal of Computational Finance
- Bailey, Borwein, Lopez de Prado & Zhu, *Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance* (2014), Notices of the AMS 61(5)
- Bailey & Lopez de Prado, *The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality* (2014), Journal of Portfolio Management 40(5)

**Champion/challenger and A/B testing in trading:** the only sources found were generic AI/engineering material rather than trading-desk practice. See "WHAT I COULD NOT FIND". The closest codified equivalent is RTS 6 Art. 8 "controlled deployment" with predefined limits. `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589

---

### B5. Monitoring of a running algo — what is on the ops dashboard

#### B5.1 The regulatory requirement is real-time and has a latency bound

RTS 6 Article 16 `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589:

> "An investment firm shall, during the hours it is sending orders to trading venues, monitor in real time all algorithmic trading activity that takes place under its trading code, including that of its clients, for signs of disorderly trading, including **trading across markets, asset classes, or products**."
> "The real-time monitoring of algorithmic trading activity shall be undertaken by **the trader in charge of the trading algorithm** or algorithmic trading strategy, **and by the risk management function or by an independent risk control function** established for the purpose of this provision. That risk control function shall be considered to be independent... provided that that function is not hierarchically dependent on the trader and **can challenge the trader**."
> "The systems for real-time monitoring shall have real-time alerts to assist staff in identifying unanticipated trading activities undertaken by means of an algorithm... Those systems shall also provide alerts in relation to algorithms and DEA orders triggering circuit breakers of a trading venue. **Real-time alerts shall be generated within five seconds after the relevant event.**"
> "An investment firm shall ensure that the competent authority, the relevant trading venues and, where applicable, DEA providers, clearing members and central counterparties can at all times have access to staff members in charge of real-time monitoring... including its contact procedures for out of trading hours."

Also required: **market-abuse surveillance** (Art. 13) — an automated system that "monitors orders and transactions, generates alerts and reports", must "cross-check any indications of suspicious trading activity", be reviewable at least annually, and "be able to read, replay and analyse order and transaction data on an ex-post basis" with alerts "at the beginning of the following trading day or, where manual processes are involved, at the end of the following trading day." `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589

#### B5.2 Execution-quality monitoring metrics

A vendor's tool documentation gives the concrete checks comparing *intent* (signals/alerts) to *reported fills* `[PRIMARY - vendor tool documentation]` https://docs.algo-trade-analytics.com/guides/alerts-vs-fills:

> "Slippage — The difference between your intended price and actual fill price"
> "Latency — Delays from signal generation to reported fills"
> "Missing Fill Reports — Alert intents with no matching imported fill"
> "Partial Fills — Fills reported at different sizes than intended"

Note the interface this sits behind: a "Backtest vs Alerts" comparison, i.e. live-vs-backtest divergence checking as a first-class dashboard view. `[PRIMARY - vendor tool documentation]` https://docs.algo-trade-analytics.com/guides/alerts-vs-fills

#### B5.3 "Is the model broken, or is it a drawdown?" — attribution and decay tests

A quant-blog treatment gives the canonical diagnostics for strategy decay `[FOLKLORE - vendor/SEO content; the McLean & Pontiff citation is real but the operational thresholds are unsourced]` https://www.alphanume.com/blog/what-is-signal-decay:

> "IC by forward horizon. The information coefficient... should be computed at multiple forward horizons: 1 day, 5 days, 21 days, 63 days. Plotting IC against horizon gives the decay profile directly. The horizon at which IC approaches zero defines the boundary of the signal's useful life."
> "**Rolling IC and live-vs-backtest comparison.** Computing IC on a rolling 12-month or 24-month window over the live period, then overlaying the in-sample backtest IC, reveals secular decay. A persistent gap between backtest IC and live IC that widens over time is the canonical signature of post-publication attrition."
> "**Performance attribution over time.** Decomposing portfolio returns by signal contribution, not just in aggregate but period by period, shows whether the erosion is concentrated in particular market regimes or is broad-based. Regime-specific failure suggests a different remediation than uniform decay across all environments."
> "Distinguishing genuine economic decay from initial overfit requires long out-of-sample tracks and honest historical attribution, which most strategies do not have."

And the resulting decision rule, which is the decommissioning test `[FOLKLORE - vendor/SEO content]` https://www.alphanume.com/blog/what-is-signal-decay:

> "**Honest deprecation.** When decay is sufficiently advanced — when rolling live IC is not statistically distinguishable from zero and attribution shows no regime in which the signal adds value — the right answer is to remove it from the portfolio... The discipline to deprecate is as important as the discipline to research new signals."

It also names capacity as the correct response to crowding — "the correct response is often to limit capital allocated to the signal rather than to abandon it" — and the underlying mechanism from McLean & Pontiff (returns attenuate significantly after anomaly publication). `[FOLKLORE - vendor/SEO content citing academic literature]` https://www.alphanume.com/blog/what-is-signal-decay

**The drawdown-vs-broken test at portfolio level** is not codified anywhere I found for discretionary books. The nearest primary evidence is Renaissance's 2020 disclosure, where the firm concluded the *model* was at fault, not merely experiencing a drawdown: beta models "in recent volatile markets have not performed as expected." `[SECONDARY - journalism reporting a firm filing]` https://www.financial-planning.com/articles/renaissance-says-quant-investing-models-misfired-during-march-mayhem

**P&L attribution** is the standard mechanism for separating alpha from beta from costs `[FOLKLORE - vendor content marketing; the decomposition is standard but the statistics are unsourced]` https://www.finantrix.com/articles/what-is-a-pl-explain-attribution-by-sector-region-security:

> "P&L attribution frameworks typically decompose returns into three primary categories: allocation effects, selection effects, and interaction effects."
> "For hedge funds operating multi-strategy platforms, attribution systems must handle additional complexity layers including use effects, financing costs, and cross-asset correlations."
> "Funds typically establish dedicated P&L reconciliation teams responsible for investigating variances exceeding 5-10 basis points daily, with escalation procedures for differences above 25 basis points requiring senior management review."

A second vendor treatment frames attribution as the discipline that "ensures that reported alpha is genuine—not disguised factor exposure or fortunate market conditions." `[FOLKLORE - vendor content]` https://breakingalpha.io/insights/performance-attribution-analysis-multi-strategy-portfolios

---

### B6. Post-trade operations

#### B6.1 Drop copy reconciliation and post-trade credit controls (FIA)

`[PRIMARY - industry association, summarised in trade press]` https://posttrade360.com/news/infrastructure/fias-best-practices-for-automated-trading-risk-controls-a-post-trade-zoom-in/

> "A combination of post-trade controls, monitoring, and data collection should be used in conjunction with pre-trade controls to watch for potential credit events or unintended trading"
> Drop copies "detail a participant's execution activity on a trading venue and [are] generated as close to real-time as possible"; FIA recommends they "be available for all trading venues and products whenever technologically practicable", that "exchanges should seek consistency in the format of drop-copy reports to assist in consolidation", and that "a frequent reconciliation process where the firm balances its trading systems to drop copy or clearing information can serve as an early warning for potential problems".
> Post-trade credit controls are "a key feature of how a broker manages its exposure to its customers"; limits should reflect "the market participant's capital base, clearing arrangements, trading style, experience and risk tolerance" and "should be monitored across the customer's entire portfolio".
> **Error trade policies:** these "should be designed to balance market participants' need for trade certainty with the adverse effects of trades being executed at prices inconsistent with prevailing market conditions"; "the goal of any error trade policy should be to promote a marketplace where all trades stand as executed. If this cannot be achieved, a price adjustment should always be preferred over cancellation, as it's less disruptive to impacted market participants."

#### B6.2 T+1 and break management

A vendor analysis of hedge-fund reconciliation describes the operating model and the T+1 compression `[FOLKLORE - vendor content marketing; detailed and internally consistent but unsourced]` https://www.finantrix.com/in-focus/systematic-alpha-technology-stack-modern-hedge-fund/prime-brokerage-custody-reconciliation-automation:

> "post the May 2024 transition to T+1 settlement in US equities and corporate bonds, the timing tolerance for breaks has collapsed from 36 hours to under 6."
> "under the SEC's amended Rule 15c6-1, broker-dealers must affirm institutional trades by 9:00 PM ET on trade date, meaning reconciliation breaks must be identified and resolved within hours, not the next business day."
> "DTCC data from the first six months post-implementation showed affirmation rates rising from 73% to 95%+, but funds without automated recon saw fail rates spike 30-50% during the transition."
> "Funds that ran end-of-day batch reconciliation on T+0 nightly cycles are now structurally late. By the time the 6 AM ET recon report flags a position break, the affirmation deadline has already passed. Intraday reconciliation — minimally at NOON, 3 PM, and 6 PM ET — is no longer optional for any fund trading US equities at scale."
> Break-rate targets: "0.3-0.5% Target break rate post-automation for tier-1 hedge fund operations, down from 3-8% on legacy manual processes."

The reconciliation **universe** it lists is the useful part for the brief — eight domains: position recon ("by CUSIP, ISIN, or SEDOL across the order management system, the PB stock record, and the fund administrator's shadow books"), cash recon ("including segregated client money pools governed by SEC Rule 15c3-3 and FCA CASS 7"), transaction recon ("matches trade-by-trade executions, allocations, and commissions back to FIX drop copies"), swap/CFD recon ("daily resets, financing accruals (typically OBFR or SOFR plus spread), dividend pass-throughs, and corporate action adjustments"), stock loan recon ("borrow positions, rebate rates, and recall notices"), margin and collateral recon ("UMR phase 6, cleared derivatives at CME and LCH, and tri-party collateral programs at BNY and Euroclear"), fee and expense recon ("ticket charges, ECN rebates, regulatory fees (Section 31, FINRA TAF), and PB financing spreads"), and corporate action recon ("historically the source of the highest-dollar breaks, with single missed elections sometimes costing seven figures"). `[FOLKLORE - vendor content marketing]` https://www.finantrix.com/in-focus/systematic-alpha-technology-stack-modern-hedge-fund/prime-brokerage-custody-reconciliation-automation

The multi-prime reality is stated as a post-Archegos structural change: "Post-Archegos (March 2021), prime brokers tightened concentration limits, and most funds above $1B AUM run 2-5 PB relationships"; each PB has distinct formats ("Goldman's GS360 files differ from Morgan Stanley's Matrix, JPM's eXecute, and Barclays' BARX feeds"). `[FOLKLORE - vendor content marketing]` https://www.finantrix.com/in-focus/systematic-alpha-technology-stack-modern-hedge-fund/prime-brokerage-custody-reconciliation-automation

**T+1 and hedge-fund trade matching** is also being addressed at infrastructure level: DTCC launched "an automated tri-party trade matching workflow on its central trade matching (CTM) platform" because prime brokers were receiving details from hedge funds "in a multitude of formats and at varying times throughout execution day and sometimes T+1", delaying post-trade processing. `[SECONDARY - trade journalism reporting DTCC]` https://posttrade360.com/news/infrastructure/dtcc-launches-new-tri-party-matching-workflow/

#### B6.3 Crypto-specific: funding rate accounting, on-chain vs CEX reconciliation

The most substantive crypto-operations source found describes the mechanics and the controls `[FOLKLORE - vendor content marketing; mechanically accurate on funding but controls are unsourced]` https://www.cv5capital.io/insights/crypto-basis-trades-institutional-funds:

> "Perpetuals do not expire. They use a periodic funding payment, typically every eight hours, to anchor the perpetual price to the underlying index. When the perpetual trades at a premium to spot, longs pay shorts a positive funding rate. When the perpetual trades at a discount, shorts pay longs. The funding rate is therefore a real-time market price for short-term financing in crypto."
> "**Daily reconciliation between exchange-reported positions, custody balances and administrator records. Discrepancies escalate immediately rather than ageing through a weekly cycle.**"
> "One of the most under-engineered aspects of perpetual basis trading is the treatment of funding receipts. Funding flows accumulate as margin equity at the exchange. **Without a documented sweep policy, that equity grows uncontrolled at a single counterparty, increasing concentration risk.** The institutional treasury policy specifies a periodic sweep cadence, typically daily or after a defined accumulation threshold, with funding proceeds moved to the qualified custodian and only the trading collateral retained at the exchange."
> "**Independent valuation of the basis position.** The administrator marks the spot leg, the derivative leg and the funding accrual separately, with reconciliation to exchange records on every NAV date."
> "The single largest risk in crypto basis trading is not market direction. It is exchange counterparty risk."

It also supplies the current funding-rate context and the *mechanical* (non-directional) cause: "Bitcoin's 30-day average perpetual funding rate has run near minus 5 percent against a historical norm of plus 8 percent", partly because "managers experiencing redemptions are shorting bitcoin futures during the redemption notice period to neutralise price exposure while waiting for capital to leave the fund. These are mechanical risk-management trades, not directional bets." `[FOLKLORE - vendor content marketing]` https://www.cv5capital.io/insights/crypto-basis-trades-institutional-funds

**Exchange/API outage handling** — the best primary artefact found is that crypto exchanges now ship execution primitives with explicit failure semantics: Kraken's TWAP child orders are IOC and "every child order still respects the limit price you set on the parent order", and "TWAP doesn't guarantee the best price or a full fill." `[PRIMARY - exchange documentation]` https://blog.kraken.com/product/pro/twap-orders-now-available

I could not find a named-practitioner post-mortem of a specific exchange API outage with a documented risk response. See "WHAT I COULD NOT FIND".

---

### B7. Where humans remain in the loop on quant desks

**Regulation puts humans in the loop at four specific points, and this is the clearest evidence available.** From RTS 6 `[PRIMARY - regulator]` https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589:

1. **Re-enabling after an automatic throttle:** "the trading system shall be automatically disabled **until re-enabled by a designated staff member**." (Art. 15(3))
2. **Deployment authorisation:** "A person designated by the senior management of the investment firm shall authorise the deployment or substantial update of an algorithmic trading system, trading algorithm or algorithmic trading strategy." (Art. 5(2))
3. **Kill functionality:** the firm must be able to cancel immediately "as an emergency measure" any or all unexecuted orders, and must be able to "identify which trading algorithm and which trader, trading desk or, where applicable, which client is responsible for each order." (Art. 12)
4. **Independent challenge during real-time monitoring:** the risk control function "shall be considered to be independent... provided that that function is **not hierarchically dependent on the trader and can challenge the trader** as appropriate and necessary." (Art. 16(2)) Plus: "An investment firm shall have a process in place to take remedial action as soon as possible after an alert has been generated, including, where necessary, **an orderly withdrawal from the market**." (Art. 16(5))
5. **Validation and decommissioning oversight:** the annual validation report is drawn up by the risk management function, "audited by the firm's internal audit function... and be subject to approval by the investment firm's senior management." (Art. 9(2)-(3))

**FIA frames the kill switch explicitly as a qualitative human decision:** it is "only invoked based on a qualitative decision taken as a last resort when other actions have failed or may not be feasible", and it "may allow for risk-reducing orders while preventing risk-increasing orders." FIA also recommends participants "build their own kill switch functionality into their trading applications, and where possible to implement it on a sufficiently granular level to identify individual trading systems... operated both by the trader and by the person responsible for risk." `[PRIMARY - industry association]` https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

**US equivalent:** SEC Rule 15c3-5 requires CEO (or equivalent officer) annual certification, controls "under the direct and exclusive control of the broker or dealer", and annual review of effectiveness. `[PRIMARY - regulator]` https://www.law.cornell.edu/cfr/text/17/240.15c3-5

**Model governance adds the human challenge function:** SR 11-7's "effective challenge" by "objective, informed parties", with the note that "incentives to provide effective challenge to models are stronger when there is greater separation of that challenge from the model development process." `[PRIMARY - regulator]` https://www.federalreserve.gov/boarddocs/srletters/2011/sr1107a1.pdf

**Newest regulatory expression of human-in-the-loop** — SEBI, India (announced, not yet detailed):

> "The framework will require 'kill-switch and humans-in-the-loop controls along with data controls'."
> — SEBI Chairman Tuhin Kanta Pandey, reported in The Hindu BusinessLine `[SECONDARY - journalism quoting a named regulator]`
> https://www.thehindubusinessline.com/markets/sebi-to-issue-ai-guidelines-with-human-oversight-data-controls-and-kill-switches/article71363840.ece

**Where humans are *not* in the loop by design:** the layering logic in FIA is that if pre-trade controls work at participant, broker and exchange level, the human kill switch "may ultimately be considered redundant" — i.e. the design goal is to make human intervention the exception. `[PRIMARY - industry association]` https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

---

## WHAT I COULD NOT FIND

Recorded honestly. Each item was actively searched for.

1. **SEC's own small-entity compliance guide to Rule 15c3-5.** `https://www.sec.gov/files/rules/final/2010/34-63241-secg.htm` returned **HTTP 403** ("Request Rate Threshold Exceeded") on both `web_fetch` and repeated attempts. *Workaround used:* the e-CFR text of 17 CFR 240.15c3-5 via Cornell LII. `[PRIMARY - regulator, unreachable]`

2. **The FIA PTG "Recommendations for Risk Controls for Trading Firms" PDF** and the older FIA/PTG guidance documents were reachable only as PDFs linked from the FIA Electronic Trading index; `web_fetch` refuses `application/pdf`, and the 2024 consolidated paper was used instead (successfully retrieved via curl). `[PRIMARY - industry association]` https://www.fia.org/electronic-trading

3. **Federal Reserve SR 11-7 on its canonical URLs.** `https://www.federalreserve.gov/supervisionreg/srletters/sr1107.htm`, `.../sr1107a1.pdf`, and the `bankinforeg/srletters/` variants all returned **404** — the Fed appears to have restructured its SR letter URLs (current letters use a new numbering scheme). *Workaround used:* the archived path `https://www.federalreserve.gov/boarddocs/srletters/2011/sr1107a1.pdf` returned HTTP 200. `[PRIMARY - regulator]`

4. **A named practitioner stating an explicit discretionary-override rate** ("we override the model X% of the time"). Searched for "discretionary overlay", "human overlay", CTA interviews, and Winton/Man AHL/AQR material. Only the qualitative hybrid-CTA framing was found. `[NOT FOUND]`

5. **Named broker algorithmic-execution guides (Morgan Stanley, JPMorgan, Goldman Sachs).** The JPMorgan *Algorithmic Trading Guide (Europe Markets)* URL returned **404**; UBS's FX algorithmic execution disclosure and macro electronic execution PDFs returned **HTTP 403 "You don't have permission to access"**; Goldman's MiFID best-execution policy PDFs were not retrievable. *What was obtained instead:* Morgan Stanley's QSI deck (primary, but FX/fixed-income focused and dated 2014), the CFA Institute curriculum readings, Kraken's exchange-native TWAP documentation, and secondary crypto algo guides. **A current equity-specific broker algo guide with an explicit selection rules table was not obtained.** `[NOT FOUND]`

6. **The ESMA RTS 6 official consolidated text versus an HTML rendering.** EUR-Lex HTML was retrieved and Articles 5–18 were read successfully, but only the recitals and Articles 1–11 were captured in the first pass; the extract is complete for the articles cited. `[PRIMARY - regulator]`

7. **FT article "Across the multimanagerverse"** — the archive.ph snapshot returned only 551 characters (paywall/JS). **No primary multi-manager-platform document describing its own factor-exposure monitoring process was found.** The closest substitutes were trade journalism about a March 2026 multi-strat drawdown and a 13F analytics vendor's description. **This is the weakest-evidenced area of Q7 A3, and the brief should say so.** `[NOT FOUND]`

8. **Crypto-specific correlation-regime analysis.** Several attempts (HTX, Kaiko via TokenPost, Bitcoin-dominance pieces) either failed to fetch or resolved to non-analytical pages. Only general (non-crypto) correlation research and the crypto funding/basis mechanics were obtained. `[NOT FOUND]`

9. **Champion/challenger or A/B testing of trading strategies as an actual desk practice.** Search results returned generic AI-model deployment material and a GitHub spec. **RTS 6 Article 8 "controlled deployment" is the only codified near-equivalent located.** `[NOT FOUND]`

10. **A verified post-mortem of a specific crypto exchange API outage with the fund-side risk response.** Search results were dominated by low-quality aggregators. `[NOT FOUND]`

11. **SPIVA's own PDF.** `https://www.spglobal.com/spdji/en/documents/spiva/spiva-us-year-end-2024.pdf` returned **HTTP 403**; the article landing page returned only 162 characters. *Workaround used:* two independent secondary summaries (FTMarketWatch, Investor Daily) which agree on direction and give the 2024 (65%) and 2025 (79%) US large-cap figures. `[SECONDARY]`

12. **CNBC's SPIVA article body.** The page fetched (HTTP 200) but the article text was truncated by the fetcher to headline only; it is therefore **not cited for any numeric claim** in this brief. https://www.cnbc.com/2025/03/07/active-managers-keep-lagging-market-why-its-so-tough-to-beat-the-indexes.html `[SECONDARY - fetched but unusable]`

13. **Howard Marks' other directly relevant memos** (e.g. *You Can't Predict. You Can Prepare.*) were fetched but not parsed in depth; *Selling Out* was used as the primary Marks source because it addresses the sell/trim judgment question head-on.

14. **Steenbarger's and Douglas's own books** — only the blog post (primary) and secondary summaries were obtainable. No page-number-level citation to *The Daily Trading Coach* or *Trading in the Zone* is made.

---

## SOURCE INVENTORY (all fetched)

**Regulators / official**
- SEC Rule 15c3-5 (e-CFR via Cornell LII) — https://www.law.cornell.edu/cfr/text/17/240.15c3-5 `[PRIMARY]`
- MiFID II RTS 6, Commission Delegated Regulation (EU) 2017/589 (EUR-Lex HTML) — https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R0589 `[PRIMARY]`
- Federal Reserve SR 11-7 / OCC 2011-12, *Supervisory Guidance on Model Risk Management* — https://www.federalreserve.gov/boarddocs/srletters/2011/sr1107a1.pdf `[PRIMARY]`
- ESMA/MFSA note on RTS 27 & RTS 28 — https://www.mfsa.mt/wp-content/uploads/2024/02/The-European-Securities-and-Markets-Authority-ESMA-Clarifies-Certain-Best-Execution-Reporting-Requirements-under-MiFID-II.pdf `[SECONDARY]`

**Industry bodies / broker / exchange**
- FIA, *Best Practices For Automated Trading Risk Controls And System Safeguards*, July 2024 — https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf `[PRIMARY]`
- FIA Electronic Trading index — https://www.fia.org/electronic-trading `[PRIMARY]`
- FIA post-trade summary (PostTrade 360) — https://posttrade360.com/news/infrastructure/fias-best-practices-for-automated-trading-risk-controls-a-post-trade-zoom-in/ `[SECONDARY]`
- Morgan Stanley QSI, *Introduction and Overview*, Sept 2014 — https://www.morganstanley.com/content/dam/msdotcom/matrixvision/assets/pdf/QSI_Sep14_Overview.pdf `[PRIMARY]`
- Kraken, TWAP orders — https://blog.kraken.com/product/pro/twap-orders-now-available `[PRIMARY]`
- FIX Trading Community guidelines index — https://fixtrading.org/download-category/guidelines/ `[PRIMARY]`
- CFA Institute, *Trade Strategy and Execution* — https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution `[PRIMARY]`
- CFA Institute, *Trading Costs and Electronic Markets* — https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trading-costs-and-electronic-markets `[PRIMARY]`
- CFA Institute RPC, *Why Static Portfolios Fail When Risk Regimes Change* — https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/why-static-portfolios-fail-when-risk-regimes-change `[SECONDARY]`

**Named practitioners**
- Howard Marks, *Selling Out*, Oaktree, 13 Jan 2022 — https://www.oaktreecapital.com/insights/memo/selling-out `[PRIMARY]`
- Rob Carver, *Vol Targeting and Trend Following* — https://qoppac.blogspot.com/2018/07/vol-targeting-and-trend-following.html `[PRIMARY]`
- Brett Steenbarger, *What I See Among Many of the Best Traders* — http://traderfeed.blogspot.com/2009/12/what-i-see-among-many-of-best-traders.html `[PRIMARY]`
- Michael Mauboussin, Morningstar *The Long View* — https://dhms8q85tpugt.cloudfront.net/retirement/michael-mauboussin-finding-easy-games `[PRIMARY]`
- Michael Mauboussin, Acquirers Podcast transcript — https://acquirersmultiple.com/2019/10/ep-32-the-acquirers-podcast-michael-mauboussin-big-decisions-luck-skill-complexity-and-success-in-investing/ `[PRIMARY]`
- George Patterson, Top Traders Unplugged ALO35 — https://pod.wave.co/podcast/top-traders-unplugged-8b7faedb-66ff-4bb4-a1c3-f8cafa3b56b4/alo35-why-macro-investing-is-becoming-more-systematic-ft-george-patterson `[PRIMARY via transcript notes]`
- Nick Patterson (ex-Renaissance) via Bloomberg/Financial Planning — https://www.financial-planning.com/articles/renaissance-says-quant-investing-models-misfired-during-march-mayhem `[SECONDARY quoting PRIMARY]`
- Sean Keane via Traders Magazine (SNB/RBA minutes) — https://www.tradersmagazine.com/departments/technology/robot-trades-inflamed-then-soothed-markets-after-franc-shock/ `[SECONDARY quoting PRIMARY]`
- FlexTrade / Vijay Kedia, FlexAlgoWheel — https://mondovisione.com/media-and-resources/news/flextrade-launches-flexalgowheel-next-generation-intuitive-interface-for-syst-2017515/ `[PRIMARY - vendor announcement with named executive]`

**Academic / behavioural**
- Kahneman excerpt via Business Insider — https://www.businessinsider.com/daniel-kahneman-on-wealth-management-2012-12 `[SECONDARY reproducing PRIMARY]`
- Kahneman quotes via LibQuotes — https://libquotes.com/daniel-kahneman/quotes/skill `[FOLKLORE]`
- Tetlock summary — https://www.intdemocratic.org/en/why-experts-almost-always-get-it-wrong-2.html `[SECONDARY]`
- Hutchinson & O'Brien via Peak Investment Solutions — https://www.peakis.net/2016/10/03/trend-following-works-weakest-financial-crises/ `[SECONDARY]`
- Bailey/Lopez de Prado et al. via pypbo README — https://raw.githubusercontent.com/plaintext-capital/pypbo/master/README.md `[SECONDARY citing PRIMARY]`
- SPIVA via FTMarketWatch — https://ftmarketwatch.com/research/spiva-active-vs-passive-funds.html `[SECONDARY]`
- SPIVA via Investor Daily — https://www.investordaily.com.au/active-managers-struggle-against-top-heavy-market-performance/ `[SECONDARY]`

**Lower-confidence / flagged**
- Opalesque, *"Diversification In Name Only"* — https://www.opalesque.com/714652/In_Name_why_most_portfolios465.html `[SECONDARY]`
- HedgeCo.Net, *"March Malaise"* — https://hedgeco.net/news/04/2026/march-malaise-results-are-in-critical-stress-test-of-the-modern-pod-based-hedge-fund-model.html `[SECONDARY]`
- Conyers, VASP governance lessons — https://www.conyers.com/publications/view/the-importance-of-sound-corporate-governance-for-virtual-asset-service-providers-lessons-from-past-failures/ `[SECONDARY]`
- Klarman, *Margin of Safety* ch.13 via Marram — http://www.marramllc.com/blog/pmjar/1679 `[SECONDARY reproducing PRIMARY]`
- Bookmap on Mark Douglas — https://bookmap.com/blog/5-truths-of-trading `[SECONDARY]`
- TurtleTrader on Willowbridge — https://www.turtletrader.com/trader-willowbridge/ `[SECONDARY]`
- TurtleTrader on Steenbarger — https://www.turtletrader.com/brett-steenbarger5/ `[SECONDARY]`
- Proactive Investors on de-grossing — https://www.proactiveinvestors.com/companies/news/939874/reddit-stock-buying-insurgency-triggers-hedge-fund-de-grossing--but-what-does-that-even-mean-939874.html `[SECONDARY]`
- The TRADE on ESMA RTS 27/28 — https://www.thetradenews.com/esma-proposes-changes-to-burdensome-mifid-ii-best-execution-reporting-requirements/ `[SECONDARY]`
- The TRADE on FIX TCA — https://www.thetradenews.com/fix-tackles-tca-standardisation-and-hft/ `[SECONDARY]`
- PostTrade 360 on DTCC CTM tri-party — https://posttrade360.com/news/infrastructure/dtcc-launches-new-tri-party-matching-workflow/ `[SECONDARY]`
- The Hindu BusinessLine on SEBI AI/ML guidelines — https://www.thehindubusinessline.com/markets/sebi-to-issue-ai-guidelines-with-human-oversight-data-controls-and-kill-switches/article71363840.ece `[SECONDARY]`
- Benzinga on walk-forward analysis — https://cdn2.benzinga.com/Opinion/26/05/52497471/walk-forward-analysis-in-trading-what-it-is-how-it-works-and-when-its-truly-useful `[SECONDARY]`
- OpenAlgo execution algorithms — https://openalgo.in/quant/execution-algorithms `[FOLKLORE]`
- CoinRoutes crypto execution algorithms — https://coinroutes.com/cn/academy/crypto-execution-algorithms-twap-vwap-pov-is/ `[FOLKLORE]`
- tradingstrategy.ai walk-forward glossary — https://tradingstrategy.ai/glossary/walk-forward-analysis `[FOLKLORE]`
- Alphanume on signal decay — https://www.alphanume.com/blog/what-is-signal-decay `[FOLKLORE]`
- Breaking Alpha on tail risk — https://breakingalpha.io/insights/tail-risk-hedging-quantitative-trading-strategies `[FOLKLORE]`
- Breaking Alpha on performance attribution — https://breakingalpha.io/insights/performance-attribution-analysis-multi-strategy-portfolios `[FOLKLORE]`
- Finantrix on P&L explain — https://www.finantrix.com/articles/what-is-a-pl-explain-attribution-by-sector-region-security `[FOLKLORE]`
- Finantrix on prime brokerage reconciliation — https://www.finantrix.com/in-focus/systematic-alpha-technology-stack-modern-hedge-fund/prime-brokerage-custody-reconciliation-automation `[FOLKLORE]`
- CV5 Capital on gross/net exposure — https://www.cv5capital.io/insights/gross-exposure-vs-net-exposure-hedge-funds `[FOLKLORE]`
- CV5 Capital on crypto basis trades — https://www.cv5capital.io/insights/crypto-basis-trades-institutional-funds `[FOLKLORE]`
- Algo Trade Analytics, alerts vs fills — https://docs.algo-trade-analytics.com/guides/alerts-vs-fills `[PRIMARY - vendor tool docs]`
- TechInterview.org Millennium guide — https://www.techinterview.org/companies/millennium-management-interview-guide/ `[FOLKLORE]`
- 13F Insight on pod shops — https://13finsight.com/learn/pod-shops-multi-manager-platforms-13f `[FOLKLORE]`
- DayTradingToolkit on sitting out — https://daytradingtoolkit.com/beginners-guide/when-to-sit-out-not-trading `[FOLKLORE]`
- Bybit Learn on no-trade — https://www.bybit.global/en/learn/trading/the-power-of-no-trade `[FOLKLORE]`
