// The grant of a settled vesting deal, as a card of its deal's page: where it stands on its schedule, as a timeline
// and in numbers and words (start, cliff and end in UTC; vested, claimed, claimable and locked), what its vault and
// its beneficiary's wallet hold, when claiming becomes possible, and the one button that claims. It only draws: the
// deal's page (v2-deal-page.js) reads the chain and sends the transactions.
import { same } from "./eth.js";
import { action, amount, fact, fromNow, h, networkName, NO_WALLET, notice, short, utc } from "./ui.js";
import { formatAmount } from "./units.js";
import { vestedAt } from "./v2.js";

const WORDS = { "not-started": "Not started", cliff: "Before the cliff", vesting: "Vesting", vested: "Fully vested", claimed: "Fully claimed" };
/** `part` of `whole` as a percentage with two decimals, rounded down, between 0 and 100. */
const percent = (part, whole) => (part <= 0n ? 0 : part >= whole ? 100 : Number((part * 10_000n) / whole) / 100);

/**
 * The grant's card. `s` is the deal page's state (the grant, its token as `base`, the latest `block`, what the
 * beneficiary's wallet holds, `busy` and `notice`); `press` holds what its button can start: connect, switchNetwork, claim.
 */
export function grantCard({ config, wallet }, s, press) {
  const g = s.grant, t = s.base, time = s.block.time, me = wallet?.account, mine = Boolean(me && same(me, g.beneficiary));
  const state = g.claimed === g.allocation ? "claimed" : time >= g.end ? "vested" : time < g.start ? "not-started" : time < g.cliff ? "cliff" : "vesting";
  const locked = g.allocation - g.vested, backed = g.held >= g.allocation - g.claimed, cliff = g.cliff > g.start;
  const number = (label, testid, units) => fact(label, h("span", { testid }, formatAmount(units, t.decimals)), ` ${t.symbol}`);
  const date = (label, testid, seconds) => fact(label, h("span", { testid, "data-time": String(seconds) }, utc(seconds)),
    Number(seconds) === time ? " (now)" : ` (${fromNow(Number(seconds) - time)})`);
  const vestedShare = percent(g.vested, g.allocation), claimedShare = percent(g.claimed, g.allocation), cliffAt = percent(g.cliff - g.start, g.end - g.start);
  return h("section", { class: "card grant" },
    h("div", { class: "card-head" }, h("h2", {}, `Grant #${g.id}`),
      h("span", { class: `status grant-${state}`, testid: "grant-status", "data-status": state }, WORDS[state])),
    h("p", { class: "lead" }, `${amount(g.allocation, t)} for ${mine ? "you" : "the buyer"}, unlocking from the start to the end of the schedule. Times are the chain's, shown in UTC.`),
    h("div", { class: "timeline", role: "img", "aria-label": `Vesting timeline: ${vestedShare}% vested, ${claimedShare}% claimed, ${percent(locked, g.allocation)}% locked. ${WORDS[state]}.` },
      h("div", { class: "track" },
        h("div", { class: "fill vested", style: `width:${vestedShare}%` }),
        h("div", { class: "fill claimed", style: `width:${claimedShare}%` }),
        cliff && h("i", { class: "mark cliff", style: `left:${cliffAt}%` }),
        h("i", { class: "mark now", style: `left:${percent(BigInt(time) - g.start, g.end - g.start)}%` })),
      h("div", { class: "ticks" }, h("span", {}, "Start"), cliff && h("span", { class: "tick-cliff", style: `left:${cliffAt}%` }, "Cliff"), h("span", {}, "End"))),
    h("p", { class: "legend" }, h("i", { class: "key claimed" }), "claimed ", h("i", { class: "key vested" }), "vested, not claimed yet ", h("i", { class: "key locked" }), "locked"),
    h("dl", { class: "facts numbers" },
      number("Allocation", "grant-allocation", g.allocation),
      number("Vested", "grant-vested", g.vested),
      number("Claimed", "grant-claimed", g.claimed),
      number("Claimable now", "grant-claimable", g.claimable),
      number("Locked", "grant-locked", locked)),
    h("p", { class: "hint", testid: "grant-next" }, next(g, t, state, time)),
    h("dl", { class: "facts" },
      date("Start", "grant-start", g.start),
      cliff ? date("Cliff", "grant-cliff", g.cliff) : fact("Cliff", h("span", { testid: "grant-cliff", "data-time": String(g.cliff) }, "None: unlocking began with the start")),
      date("End, fully vested", "grant-end", g.end),
      fact("Beneficiary, the only address the grant pays", h("span", { class: "mono", testid: "beneficiary" }, g.beneficiary), mine && " (you)",
        h("span", { class: "block" }, "This wallet holds ", h("span", { testid: "beneficiary-balance" }, formatAmount(s.buyerHolds, t.decimals)), ` ${t.symbol} now.`)),
      fact("Vault", h("span", { class: "mono", testid: "vault" }, g.custodian),
        h("span", { class: backed ? "block ok" : "block bad", testid: "grant-backing", "data-backed": String(backed) }, backed
          ? `Fully backed: it holds ${amount(g.held, t)}, everything not claimed yet.`
          : `It holds ${amount(g.held, t)}, less than the ${amount(g.allocation - g.claimed, t)} not claimed yet.`)),
      fact("Read at", h("span", { testid: "as-of", "data-block": String(s.block.number) }, `block ${s.block.number}, ${utc(time)}`))),
    claiming({ config, wallet }, s, press, state, mine));
}

/** In words: what can be claimed now, and when claiming becomes possible if it is not. */
function next(g, t, state, time) {
  const until = (seconds) => `${utc(seconds)} (${fromNow(Number(seconds) - time)})`, locked = amount(g.allocation - g.vested, t);
  if (state === "claimed") return "Everything has been claimed: this grant is complete.";
  if (state === "vested") return `The grant is fully vested: the ${amount(g.claimable, t)} not claimed yet can be claimed at any time.`;
  if (state === "not-started" || state === "cliff") {
    const first = g.cliff > g.start ? `the cliff, ${until(g.cliff)}. Then ${amount(vestedAt(g, g.cliff), t)} unlock at once, what accrued since the start` : `the start, ${until(g.start)}`;
    return `Nothing can be claimed yet. Claiming becomes possible at ${first}, and the rest unlocks second by second until ${utc(g.end)}.`;
  }
  if (g.claimable === 0n) return `Everything vested so far is claimed. ${locked} are still locked and unlock second by second until ${utc(g.end)}.`;
  return `${amount(g.claimable, t)} can be claimed now. ${locked} are still locked and unlock second by second until ${utc(g.end)}.`;
}

/** The button that claims (connect, switch network, claim), for the beneficiary only. */
function claiming({ config, wallet }, s, press, state, mine) {
  const g = s.grant, me = wallet?.account, steps = ["Connect", "Claim"];
  if (state === "claimed") return s.notice && h("div", { class: "action" }, notice(s.notice));
  if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: !s.busy.waiting && s.busy.hint });
  if (!wallet) return action({ steps, step: 0, button: { label: "Connect a wallet to claim" }, notice: { kind: "info", text: NO_WALLET } });
  if (!me) return action({ steps, step: 0, button: { label: "Connect wallet", run: press.connect }, hint: "Connect the beneficiary's wallet. Nothing is sent yet.", notice: s.notice });
  if (!mine) {
    return action({ notice: { kind: "warn", text: `Only the beneficiary, ${g.beneficiary}, can claim, and the tokens only ever go to that address. `
      + `Your wallet is connected as ${short(me)}.` } });
  }
  if (wallet.chainId !== config.chainId) {
    return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: press.switchNetwork },
      hint: `Your wallet is on ${networkName(wallet.chainId)}, and this grant is on ${networkName(config.chainId)}.`, notice: s.notice });
  }
  if (g.claimable === 0n) return action({ steps, step: 1, button: { label: "Nothing to claim yet" }, notice: s.notice });
  return action({ steps, step: 1, button: { label: `Claim ${amount(g.claimable, s.base)}`, run: press.claim },
    hint: "The tokens go to your wallet, with no fee. The chain pays everything vested at the moment the transaction is confirmed, so it can be slightly more than shown.",
    notice: s.notice });
}
