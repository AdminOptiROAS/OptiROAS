# OptiROAS acceptance pass, 28 Oct 2026 (checklist item 15)

Automated browser runs (Chromium, Playwright) against the built site with mocked accounts and ad platforms.
"Not run here" means it needs live accounts and is checked manually.

| Area | Step | Result | Evidence (test) |
|---|---|---|---|
| Accounts | Sign up, sign out, sign in | Pass | accept.js |
| Accounts | Password recovery request and reset link | Pass | accept.js |
| Accounts | Email confirmation picked up without refresh | Pass | free_test.js |
| Uploads | Guided upload, coverage preview, generate | Pass | fx_test.js, wz flow |
| Uploads | Invalid file named with next step, valid file kept | Pass | accept.js |
| Uploads | Mixed currencies flagged | Pass | accept.js |
| Uploads | Overlapping exports never double counted | Pass | dup_test.js |
| Connected | Meta pull by main objective, other goals listed | Pass (mocked API) | goal_test.js, og_test.js |
| Connected | Google, Snapchat, TikTok objectives | Pass (mocked CSV layouts) | plat_obj_test.js |
| Connected | Live dashboard and refresh with today | Pass (mocked API) | live_test.js |
| Report | Sparse data: no score, forecast or budget moves; checklist shown | Pass | sparse_test.js |
| Report | Multiple platforms (example report) | Pass | qa.js |
| Report | Business goal, target, lead value | Pass | biz_test.js |
| Report | Action cards, dismiss, example keeps own report | Pass | s2_test.js |
| Report | Calculator ranges, assumptions, test plan | Pass | calc_test.js |
| Report | What changed and since last saved report | Pass | hist_test.js |
| Report | Store order matching and delivered revenue | Pass | deliv_test.js |
| Keep | Session kept across refresh until sign out | Pass | sess_test.js |
| Keep | Save to account, reopen, progress sync | Pass | keep_test.js |
| Keep | Action plan and full summary PDF, free limits | Pass | keep_test.js, free_test.js |
| Keep | Report email (consent first) | Pass (mocked send) | keep_test.js |
| Access | Keyboard focus ring on report tabs, Enter opens | Pass | accept.js |
| Access | Contrast ≥ 4.5:1 (body 17.5, muted 5.8, buttons 6.0) | Pass | accept.js |
| Access | Mobile 390px: no sideways scroll on home, wizard, pricing, every tab | Pass | accept.js |
| Arabic | Right to left, translated tabs and site text | Pass | accept.js, ar_site_test.js, fix_test.js |
| Live accounts | Real Meta, Google, Snapchat pulls | Not run here | needs connected accounts |
| Live accounts | Real email delivery, Stripe checkout | Not run here | needs live services |
| Monitoring | Weekly refresh and email alerts | Not offered | removed from site copy until built |
