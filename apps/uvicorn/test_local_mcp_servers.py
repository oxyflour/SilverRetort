import json
import os
import tempfile
import unittest
from pathlib import Path

import local_mcp_servers


class LocalMcpServersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_data_dir = os.environ.get("DATA_DIR")
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["DATA_DIR"] = self.temp_dir.name

    def tearDown(self) -> None:
        if self.previous_data_dir is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous_data_dir
        self.temp_dir.cleanup()

    def write_settings(self, payload: dict) -> None:
        Path(self.temp_dir.name, "settings.json").write_text(json.dumps(payload), "utf-8")

    def test_load_servers_includes_enabled_installed_managed_mcp(self) -> None:
        self.write_settings({
            "managedMcpServers": {
                "cst_studio": {
                    "serverName": "cst_studio",
                    "enabled": True,
                    "installedVersion": "0.1.0",
                    "running": True,
                    "port": 9901,
                }
            }
        })

        servers = local_mcp_servers.load_servers()

        self.assertEqual(servers["cst_studio"]["url"], "http://127.0.0.1:9901/mcp/")

    def test_load_servers_skips_disabled_or_uninstalled_managed_mcp(self) -> None:
        self.write_settings({
            "managedMcpServers": {
                "disabled": {
                    "serverName": "disabled",
                    "enabled": False,
                    "installedVersion": "0.1.0",
                    "port": 9902,
                },
                "missing_version": {
                    "serverName": "missing_version",
                    "enabled": True,
                    "running": True,
                    "port": 9903,
                },
                "stopped": {
                    "serverName": "stopped",
                    "enabled": True,
                    "installedVersion": "0.1.0",
                    "running": False,
                    "port": 9904,
                },
            }
        })

        servers = local_mcp_servers.load_servers()

        self.assertNotIn("disabled", servers)
        self.assertNotIn("missing_version", servers)
        self.assertNotIn("stopped", servers)


if __name__ == "__main__":
    unittest.main()
