# Silent Partner

The back office, handled. Live at **https://silentpartnerhq.netlify.app**

A free, private back office for a small business. It keeps track of the money all year, so that
"can we afford this?" takes a minute instead of an afternoon of spreadsheets.

Built for ENT 1000 at Washington and Lee, Fall 2026, by Jillian Gangaram, Caitlyn Crouch and
Claudia Ramirez, out of nine interviews across eight local businesses.

## What it does

- **Safe to spend today** — what is left after every bill it knows about and a cushion for
  surprises, with every line of the arithmetic shown
- **Can we afford it?** — checks one amount and pushes back, naming the bills at risk
- **Year-end payout** — holds back what the business needs to open again and the manager
  payouts, then shows what is left for the owners
- **Manager payouts** — splits a pool evenly or by weighted shares
- **Expenses** — missing details, possible duplicates and large amounts are flagged for a
  second look before they count
- **Bills & sales** — bank balance, weekly sales, repeat bills
- **Weekly update** — a plain-language summary to copy. Nothing is ever sent for you
- **Pricing** — whether a product still makes money once you pay yourself
- **History** — every sign-in and every change, with a name against it, which nobody can edit
- **A walkthrough** — `guide.html`, 30 pages in plain English with a picture of every part

Everyone who uses it makes their own account, and everyone sees the same books from any device.
Two people can work at once without overwriting each other.

Pages you do not need can be switched off under **Settings → Which pages you want**. Nothing is
deleted; switch one back on and what was in it is still there.

The owner makes every decision. The site organises, flags, and shows its working.

## What is private, and what is not

Your books live in a Supabase database that only this site's accounts can open. That rule is
enforced by the database itself, not by the page, so editing the page in a browser gets nobody
in. Passwords are hashed by Supabase and cannot be read by anyone, including whoever runs this.
All traffic is over HTTPS, and every change is signed with a name and a time under **History**.

Being straight about the limit: Supabase, as the company hosting the database, could
technically read what is in it. An earlier version of this site encrypted everything with a
password that never left the browser, and could honestly say that nobody at all could read it.
That version could not offer a "forgot password" link, because the password *was* the key. You
cannot have both. This one chose the version a real shop can actually use.

## Running your own copy

1. Make a free project at [supabase.com](https://supabase.com).
2. Paste `supabase/schema.sql` from the source repository into its SQL Editor and run it.
3. Put that project's URL and its **publishable** key into `config.js`.
4. Serve this folder as a static site. There is nothing to build and nothing to install.

Set up custom SMTP in Supabase before letting strangers sign up. The built-in mail service is
capped at two messages an hour, so the third person to ask for a password reset gets nothing.

