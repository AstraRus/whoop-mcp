<div align="center">

# whoop-mcp

**Your WHOOP data, in a conversation with Claude.**

Ask about your recovery, sleep, strain and workouts in plain language and get
answers built from your own numbers.

[![CI](https://github.com/AstraRus/whoop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AstraRus/whoop-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](https://nodejs.org)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![Self-host on Railway](https://img.shields.io/badge/self--host-Railway-0B0D0E.svg?logo=railway&logoColor=white)](docs/self-hosting.md)

**[Set up your own →](docs/self-hosting.md)** &nbsp;·&nbsp; [What you can ask](#what-you-can-ask) &nbsp;·&nbsp; [What it can do](#what-it-can-do) &nbsp;·&nbsp; [Privacy](#privacy-and-security) &nbsp;·&nbsp; [Reference](docs/reference.md)

</div>

<p align="center">
  <img src="images/Claude-chat-with-whoop-mcp-integrated.png" alt="Claude answering “How was my recovery this week?” with average recovery, HRV and resting heart rate and a chart of daily recovery scores" width="720">
</p>

whoop-mcp is a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP)
server for the [WHOOP](https://www.whoop.com/) API. You run your own copy (on
Railway it costs less than a dollar a month), add it to Claude as a custom
connector, and Claude can then look at your WHOOP data whenever you ask about it.

- **Your own server, your own data.** Each person runs their own copy, signed in to their own WHOOP account. Nobody else's server ever sees your data.
- **Read-only.** It cannot change anything in your WHOOP account.
- **Honest numbers.** Missing data stays missing instead of turning into 0, and recoveries from WHOOP's first calibration days are marked as such.
- **Your days, not UTC days.** Sleep, recovery, strain and workouts are placed on your local days the way the WHOOP app shows them.

## What you can ask

> _"How am I doing today?"_
>
> _"What happened yesterday: sleep, strain and workouts?"_
>
> _"How did I sleep this week compared with what WHOOP says I needed?"_
>
> _"Compare my recovery over the last two weeks with the two weeks before."_
>
> _"How is my training load compared with the last four weeks?"_
>
> _"Debrief my last run."_
>
> _"Export the last 30 days as a CSV."_
>
> _"Why is today's data missing?"_

Claude picks the right tools by itself. Ready-made prompts cover a morning
briefing, an evening briefing, a weekly health review, a workout recap and more.

## What it can do

**28 read-only tools**, grouped by what they answer:

| Area                  | Tools                                                                                                                                                                                                 | For questions about                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Today and single days | `get_today`, `get_day`, `get_calendar`, `get_sync_status`                                                                                                                                             | today's recovery, sleep and strain; one day in detail; a day-by-day view; missing data |
| Weeks and trends      | `get_weekly_summary`, `compare_periods`, `get_trend`, `get_baselines`                                                                                                                                 | how a week went, two periods side by side, trends, your usual ranges                    |
| Sleep                 | `get_sleep_debt`, `get_sleep_analysis`, `get_sleep_need`                                                                                                                                              | sleep debt, timing, consistency and stages, an estimate of your next sleep need       |
| Recovery              | `get_recovery_analysis`, `get_recovery_drivers`                                                                                                                                                       | recovery over time and which habits go along with better or worse recovery             |
| Training              | `get_training_load`, `get_sport_breakdown`, `get_workout_log`, `get_workout_context`, `get_personal_records`                                                                                          | load against your recent average, time per sport, workout history, debriefs, bests     |
| Your data             | `export_health_data`, `get_recovery_collection`, `get_sleep_collection`, `get_workout_collection`, `get_cycle_collection`, `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`, `get_profile`, `get_body_measurement` | CSV or JSON export, raw WHOOP records, profile, height, weight and max heart rate       |

There are also 13 prompts and 6 resources. Every tool, prompt and resource is
described in the [reference](docs/reference.md#tools).

**What WHOOP doesn't share:** WHOOP's API has no Strength Trainer exercises,
sets or weights, journal entries, stress, steps, VO2 max, continuous heart rate,
or Sleep Planner and coaching, so no tool can show them.

## Set up your own

You need a WHOOP membership, a Claude account (the free plan allows one custom
connector), free GitHub and Railway accounts, and about 30 minutes. No coding.

1. **Copy this repository** to your GitHub account (Fork).
2. **Create a server on Railway** from your copy and give it an address and storage.
3. **Create a WHOOP developer app** (free) that points to that address.
4. **Paste the settings** into Railway and deploy.
5. **Sign in to WHOOP** once, with the link your server prints.
6. **Add your server to Claude** as a custom connector.

**[Open the step-by-step setup guide →](docs/self-hosting.md)**

**Cost:** Railway's trial includes $5 of credit for 30 days. After that, its free
plan includes $1 of usage a month, and one server running around the clock used
about $0.70 a month (measured in October 2026). Railway's $5-a-month Hobby plan
covers several servers, for example one for each person in a family.

## Privacy and security

- **One server per person.** A server holds one WHOOP sign-in. Anyone with your server's address _and_ its access token can read your data through it, so keep the token private. To share with a friend, help them set up their own server ([how](docs/self-hosting.md#hosting-a-server-for-someone-else)).
- **Nothing stored but the sign-in.** The only file the server writes is its WHOOP sign-in (`tokens.json` on your Railway volume). Health data is cached in memory only, for minutes to a few hours.
- **No third parties.** Data goes from WHOOP to your server to Claude when Claude calls a tool. There is no analytics or telemetry, and logs never contain health data, tokens or request contents.
- **Optional aggregate mode** releases only weekly summaries instead of daily values ([privacy modes](docs/reference.md#privacy-modes)).

## Other ways to run it

- **Claude Desktop on your own computer:** no hosting, but it only works on that computer while it's on. See [running on your own computer](docs/reference.md#running-on-your-own-computer-claude-desktop).
- **Docker, Fly.io or another host:** see [deployment](docs/reference.md#deployment-docker--cloud-hosting).

## Keeping it up to date

On your copy's GitHub page, click **Sync fork → Update branch**. Railway rebuilds
and restarts your server within a few minutes, and your WHOOP sign-in is kept.

## Documentation

- [Setup guide](docs/self-hosting.md): your own server, step by step
- [Reference](docs/reference.md): every tool, resource and prompt, privacy modes, configuration, troubleshooting, development
- [Railway runbook](docs/deploy-railway.md): running a deployment, verification, secret rotation, rollback
- [Changelog](CHANGELOG.md)

## Credits and license

Based on [whoop-ai-mcp](https://github.com/shashankswe2020-ux/whoop-mcp) by
[@shashankswe2020-ux](https://github.com/shashankswe2020-ux). This repository
continues from its version 0.7.0; see the [changelog](CHANGELOG.md) for what
0.8.0 added. Released under the [MIT license](LICENSE).

Not affiliated with, endorsed by or supported by WHOOP or Anthropic. WHOOP is a
trademark of WHOOP, Inc. Claude is a trademark of Anthropic, PBC.
