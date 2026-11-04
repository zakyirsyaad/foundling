"""The soak log (JSON lines, append only) and the small state file that survives a restart."""

import json
import os
import tempfile
from pathlib import Path


class StateError(Exception):
    pass


class JsonlLog:
    def __init__(self, path):
        self.path = Path(path)

    def write(self, record):
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")


class FileStore:
    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except ValueError:
            raise StateError(f"the state file {self.path} is not valid JSON; "
                             "move it aside to start from a clean state") from None

    def save(self, data):
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(temp, self.path)
