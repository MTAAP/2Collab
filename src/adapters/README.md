# Adapters

Adapters translate true external or remote-owned systems into the typed ports defined by deep domain modules.

V1 justifies adapters for GitHub, Outline, WebSocket runner control, Native execution hosting, Orca execution hosting, and runtime-specific prepared execution. Policy evaluation and SQLite persistence do not become public ports merely to make unit tests convenient.

Add an adapter with the first acceptance test that needs it. Keep vendor payloads, commands, credentials, local paths, and transport details out of domain interfaces.
