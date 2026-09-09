"""Refresh weekly fantasy DEF streamer board → docs/data/streamers/.

Prefer ``python -m src.run_streamers`` (DEF + kickers). This module remains as
a thin alias for older docs / workflows.
"""

from __future__ import annotations

from src.run_streamers import main

if __name__ == "__main__":
    main()
