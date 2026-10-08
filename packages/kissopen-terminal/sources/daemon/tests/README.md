# Daemon launcher tests

These tests exercise the release installer at its filesystem and Fetch boundaries. They use tiny
in-memory release responses and a fake extractor so checksum failures, atomic publication, cached
selection, and concurrent first-run launchers stay deterministic and never contact GitHub.

Home-resolution tests cover the Desktop/CLI shared directory on Windows, macOS, and Linux,
including explicit isolated installations and redirected application-data directories.
