# Demo thread draft (not posted yet, review before sending)

Handle check before posting: the Telegram contact below is verified
directly from the Cookie Chain bounty listing on Superteam Earn
(t.me/TheCookieNetChain). I could not verify a real X/Twitter handle
for Cookie Chain in search; "@TheCookieChain" as given has no
confirmed account behind it. Confirm the real handle before this goes
out, or drop the X tag and rely on the Telegram contact and whatever
official Cookie Chain account the listing itself links from.

---

1/
Family Cookie is a savings goal wallet on Cookie Chain. Connect a
wallet, create a goal with a target and a deadline, fund it, then move
money into the goal with a device passkey instead of a routine wallet
click. No swap, no price feed, no order book.

2/
Most Cookie Chain app bounty entries are swap terminals or trading
dashboards. This isn't one. The on-chain program has zero trading
instructions in it. It's built for one thing: getting money into a
goal, with a real security mechanism behind the contribute step.

3/
How the passkey part actually works: a device passkey is registered
with the vault (secp256r1, the same kind of key your phone or laptop
already generates for site logins). Contributing requires a live
WebAuthn signature from that device, verified on-chain through
Solana's secp256r1 precompile. A stolen or copied wallet key alone
cannot move money into a goal.

4/
What's real in this build: real transactions signed and sent by a
connected wallet, a real passkey registered and asserted through the
browser's own WebAuthn API, and real on-chain verification of that
signature before funds move. Nothing here is mocked or simulated for
the demo.

5/
Try it: [live URL once confirmed deployed]
Source: [public repo URL once pushed]
Cookie Chain program ID: [added once the Cookie Chain deploy is
confirmed]

6/
Built by TJS Code. Questions or feedback: t.me/TheCookieNetChain
