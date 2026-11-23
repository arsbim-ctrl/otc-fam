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
export function flow({ app, s, key, render, settle }) {
  let presses = 0; // which press the page is following: a press that is no longer the current one changes nothing
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

  /**
   * Runs one press. `work(stage, sent)` does what the press is for: `stage(text)` tells the person where it stands,
   * and `sent(hash, nonce)` is for transact(), to remember the transaction as soon as the wallet has sent it. However
   * the work ends, a transaction it remembered is forgotten again, since the page has then seen its end. `mine` says
   * that the remembered transaction is this press's from the start (a wait taken up after a reload). A press that
   * remembered nothing forgets nothing: the record may be another tab's, whose transaction is still on its way.
   */
  async function act(label, step, work, mine = false) {
    const press = ++presses;
    let result;
    s.notice = null;
    s.busy = { label, step, hint: "" };
    render();
    try {
      result = await work((hint) => {
        if (press !== presses) return;
        s.busy.hint = hint;
        render();
      }, (hash, nonce) => {
        mine = true;
        remember({ hash, nonce: nonce === null ? null : String(nonce), label, step, account: app.wallet.account });
      });
    } catch (e) {
      if (press === presses) s.notice = { kind: e.replaced ? "info" : "error", text: explain(e) };
    }
    if (press !== presses) return; // the person stopped waiting for it, or left the page
    if (mine) forget();
    await settle(result, label);
    s.busy = null;
    render();
  }

  return {
    act: (label, step, work) => act(label, step, work),
    /**
     * After a reload: takes up the transaction this browser sent before, and runs `confirmed(receipt, account)`
     * once the network has confirmed it (`account` is the one that sent it). While it waits, `s.busy.waiting` is set:
     * the page shows what is awaited, and a way to stop waiting.
     */
    resume(confirmed) {
      const pending = recall();
      if (!pending) return;
      act(pending.label, pending.step, async (stage) => {
        const press = presses;
        s.busy.waiting = true;
        stage(`This page was reloaded while transaction ${pending.hash} was on its way. Waiting for the network to confirm it.`);
        const receipt = await app.chain.confirmed(pending.hash, pending.account, pending.nonce === null ? null : BigInt(pending.nonce));
        if (press === presses) await confirmed(receipt, pending.account);
        return receipt;
      }, true);
    },
    /** Gives the page back while a transaction sent before a reload is still awaited, and says `text`. */
    async stopWaiting(text) {
      presses++;
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
