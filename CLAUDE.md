# Wasabi: notes for AI assistants working on this code

Before changing anything, read and follow **[docs/security/Security.md](docs/security/Security.md)**, and check
the change against **[docs/security/Security Checklist.md](docs/security/Security%20Checklist.md)** before committing.
Who can do what: [Auth.md](docs/security/Auth.md). Personal data: [Data Security.md](docs/security/Data%20Security.md).
Risks: [Threat Model.md](docs/security/Threat%20Model.md). Outside code register: [vendor/SOURCES.md](vendor/SOURCES.md).
How screens should look and behave (colours, type, touch sizes, words): **[DESIGN.md](DESIGN.md)**.

Ground rules in short:
- `firestore.rules` is the security. New data → new rules + tests in the same change. Keep `firestore.rules`
  identical on `staging` and `main` (shared database); rules changes only add.
- Work on `staging`; `main` is live and only changes when Vandan says "put it live" (morning/early afternoon,
  never Friday/Saturday night). The live demo is a separate copy in `demo/`: change both when a fix applies to both.
- No secrets in code. No loading code from public CDNs: vendor it, pin it, list it in vendor/SOURCES.md.
- Show user text with `esc()`. Never log personal data.
