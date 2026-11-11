# First collection launch

## Scope

Prioritize deploying the survey collector for an upcoming employee team-building event.
The proposed distribution is three different surveys, sent to roughly 200 people each
(600 invitations total). The first game can be assembled manually from selected questions
and exported results; a question library or game builder is not a launch dependency.

Five ten-question sets have now been supplied and prepared for LivIT: LivIT and Workplace,
Holiday Party, Technology, Just for Fun, and Easy "Survey Says" Questions. The catalog is
stored in `surveys/livit.json`. Which sets go to which recipients remains a distribution
decision; preparing five sets does not automatically change the original mailing plan.

Invitations are not completed responses. At 50% participation, 200 invitations produce
100 submissions before skipped questions, incomplete answers, or quality exclusions.
Monitor usable answers per question and plan reminders or additional invitations.

## Launch gates

- Confirm the authorized hosting destination and permitted data collection for this event.
- Deploy a production build behind HTTPS; verify participant devices can reach the public survey links.
- Use durable database storage. Do not treat an Azure Files network share as a proven-safe SQLite disk.
- Keep production data and credentials separate from the local preview and test fixtures.
- Bound request bodies and answer lengths, throttle login/abuse, and accommodate shared workplace IP addresses.
- Verify backups and an actual restore; test that responses survive container replacement/restart.
- Test a concurrent-submission burst using disposable data on the selected hosting arrangement.
- Finalize three surveys and any necessary background fields; minimize identifying information.
- Pilot the links with a small group before the full mailing, including phone and desktop browsers.
- Confirm an admin-only raw-answer export/recovery path for manual review; exclude background data from AI by default.
- Keep AI disabled until its provider and data use are approved. Collection does not depend on live AI.
- Monitor errors and response counts, send reminders as needed, and close collection before final tabulation.

## Deferred after the first game

- Cross-survey question library and a named game-pack builder.
- Filtering questions and results by respondent background information.
- Persisted per-answer reviewed group assignments for accurate filtered counts.
- Explicit mapping/reuse of equivalent background fields across surveys; never infer equivalence from labels alone.
- Audience-specific ranking/scoring with visible sample-size warnings; behavior still needs a product decision.
- Ready/published immutable game snapshots and automated game retrieval.

Manual selection can combine rounds from compatible JSON exports without building these features.
Any AI used to assist tabulation or assembly must use an approved destination and appropriately minimized data.

## Outstanding decision

Choose the first live hosting environment: an approved LLNL on-prem host or an authorized Azure deployment.
No live deployment or hosting approval has been verified yet.
