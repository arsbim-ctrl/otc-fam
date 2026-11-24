// One press at a time, for a page that sends transactions. While a press runs the page is busy; what went wrong is
// said in a notice; and a transaction that was sent is remembered in this browser until the page has seen how it
// ended, so that a reload does not lose it. Both v2 pages run their presses through here.
import { explain } from "./eth.js";

/**
 * `s` is the page's state: the flow keeps `s.busy` ({ label, step, hint, waiting }, or null) and `s.notice`
 * ({ kind, text }, or null) in it. `key` names the page's remembered transaction in this browser's storage.
 * `render()` draws the page. `settle(result, label)` reads again whatever a press may have changed, with what the
 * press returned; the buttons come back once it is done.
 */
export function flow({ app, s, key, render, settle, trackSent = false }) {
  let presses = 0; // which press the page is following: a press that is no longer the current one changes nothing
  let retryRecord;
  const forget = () => {
    try {
      localStorage.removeItem(key);
    } catch {} // no storage: there was nothing to forget
  };
  const remember = (record) => {
    try {
      localStorage.setItem(key, JSON.stringify(record));
    } catch {} // no storage: the page still follows the transaction until it is closed
  };
  /** The remembered transaction, if it is one this page could have written; anything else is thrown away, not taken up. */
  const recall = () => {
    try {
      const pending = JSON.parse(localStorage.getItem(key));
      if (pending === null) return null;
      const is = (pattern, value) => typeof value === "string" && pattern.test(value);
      const sound = is(/^0x[0-9a-f]{64}$/i, pending.hash) && is(/^0x[0-9a-f]{40}$/i, pending.account) && typeof pending.label === "string"
        && (pending.step === null || Number.isInteger(pending.step)) && (pending.nonce === null || is(/^\d+$/, pending.nonce));
      if (!sound) forget();
      return sound ? pending : null;
    } catch {
      return null;
    }
  };

  /** Runs a wallet step. For broker deals, an uncertain confirmation can be retried without sending again. */
  async function act(label, step, work, record) {
    const press = ++presses;
    let result;
    retryRecord = null;
    s.notice = null;
    s.busy = { label, step, hint: "" };
    render();
    try {
      result = await work((hint) => {
        if (press !== presses) return;
        s.busy.hint = hint;
        render();
      }, (hash, nonce, account = app.wallet.account) => {
        record = { hash, nonce: nonce === null ? null : String(nonce), label, step, account };
        remember(record);
        if (trackSent && press === presses) Object.assign(s.busy, { hash, waiting: true });
      });
    } catch (e) {
      if (press !== presses) return;
      if (trackSent && record && !e.reverted && !e.replaced) {
        retryRecord = record;
        Object.assign(s.busy, { hint: "The transaction was sent. The network could not confirm it yet.", retry: true });
        render();
        return;
      }
      s.notice = { kind: e.replaced ? "info" : "error", text: explain(e) };
    }
    if (press !== presses) return;
    if (record) forget();
    await settle(result, label);
    if (press !== presses) return;
    s.busy = null;
    render();
  }

  function follow(record, confirmed, text) {
    act(record.label, record.step, async (stage) => {
      const press = presses;
      s.busy.waiting = true;
      if (trackSent) s.busy.hash = record.hash;
      stage(text);
      const receipt = await app.chain.confirmed(record.hash, record.account, record.nonce === null ? null : BigInt(record.nonce));
      if (press === presses) await confirmed(receipt, record.account);
      return receipt;
    }, record);
  }

  return {
    act: (label, step, work) => act(label, step, work),
    /** After a reload, follow the hash this browser submitted. */
    resume(confirmed) {
      const record = recall();
      if (record) follow(record, confirmed, `This page was reloaded while transaction ${record.hash} was on its way. Waiting for the network to confirm it.`);
    },
    retry() {
      if (retryRecord) follow(retryRecord, () => {}, "Checking the previously submitted transaction.");
    },
    /** Gives the page back while a transaction sent before a reload is still awaited, and says `text`. */
    async stopWaiting(text) {
      presses++;
      retryRecord = null;
      forget();
      s.busy = null;
      s.notice = { kind: "info", text };
      await settle();
      render();
    },
    /** The page is left: whatever is still on its way no longer changes it. */
    stop: () => presses++,
  };
}
