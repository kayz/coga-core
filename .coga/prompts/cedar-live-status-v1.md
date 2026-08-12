# Cedar textual live-status proposal

Given the exact COGA Harness context closure and the governed change to
`web.h5.responsive.shell@0.2.0`, produce only a normalized unified Git patch for
`application.cedar.insight.h5@0.2.0`.

The candidate must:

- expose access state and source as visible text in an ARIA live status region;
- preserve the existing public-summary and authority boundaries;
- add an executable assertion for the announced text;
- change only the paths authorized by the Application Factory definition;
- contain no command, secret, network access, approval, merge, or deployment action.

Output UTF-8 unified diff bytes with LF line endings and one final newline.
