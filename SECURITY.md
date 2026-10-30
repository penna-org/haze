# Security Policy

## Supported versions

Security fixes are released as patch versions of the latest minor of the current major (`1.x`). Pre-release `0.x` versions are not supported; please upgrade to `1.x`.

## Reporting a vulnerability

Please **do not** open a public issue. Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/penna-org/haze/security/advisories/new).

Include a description, affected packages and versions, and a reproduction if possible. We aim to acknowledge reports within 3 business days and will keep you informed while a fix is prepared. Once released, we credit reporters in the advisory unless you prefer to stay anonymous.

Areas of particular interest: authentication and session handling, CSRF, signed URLs and cookies (`APP_KEY`), path handling in file storage, request parsing and body limits, and the deployment presets.
