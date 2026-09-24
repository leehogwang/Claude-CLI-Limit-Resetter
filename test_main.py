import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import main


class AuthenticationTests(unittest.TestCase):
    def test_accepts_first_party_pro_subscription(self):
        status = {
            "loggedIn": True,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "subscriptionType": "pro",
        }
        self.assertEqual(main.validate_auth_status(status), "pro")

    def test_rejects_api_auth_even_when_logged_in(self):
        status = {
            "loggedIn": True,
            "authMethod": "apiKey",
            "apiProvider": "firstParty",
            "subscriptionType": "pro",
        }
        with self.assertRaises(main.ResetterError):
            main.validate_auth_status(status)

    def test_rejects_payg_without_subscription(self):
        status = {
            "loggedIn": True,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "subscriptionType": "api",
        }
        with self.assertRaises(main.ResetterError):
            main.validate_auth_status(status)

    def test_rejects_enterprise_without_known_included_allowance(self):
        status = {
            "loggedIn": True,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "subscriptionType": "enterprise",
        }
        with self.assertRaises(main.ResetterError):
            main.validate_auth_status(status)

    def test_rejects_any_api_key_or_provider_override(self):
        for name in main.AUTH_OVERRIDE_ENV:
            with self.subTest(variable=name):
                with patch.dict(os.environ, {name: "configured"}, clear=True):
                    with self.assertRaises(main.ResetterError):
                        main.ensure_no_auth_override()


class PromptTests(unittest.TestCase):
    def test_command_uses_haiku_without_tools_or_saved_session(self):
        command = main.build_ping_command("/usr/bin/claude", "haiku", "hi")
        self.assertIn("--model", command)
        self.assertEqual(command[command.index("--model") + 1], "haiku")
        self.assertIn("--no-session-persistence", command)
        self.assertIn("--restricted", command)
        self.assertIn("--strict-mcp-config", command)
        tools_index = command.index("--tools")
        self.assertEqual(command[tools_index + 1], "")

    def test_accepts_json_result_reported_as_haiku(self):
        output = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "modelUsage": {"claude-haiku-4-5-20251001": {}},
            }
        )
        self.assertEqual(
            main.parse_cli_result(output, "haiku"),
            ["claude-haiku-4-5-20251001"],
        )

    def test_rejects_fallback_to_a_non_haiku_model(self):
        output = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "modelUsage": {"claude-sonnet-5": {}},
            }
        )
        with self.assertRaises(main.ResetterError):
            main.parse_cli_result(output, "haiku")

    def test_rejects_missing_model_usage_for_haiku(self):
        output = json.dumps(
            {"type": "result", "subtype": "success", "is_error": False}
        )
        with self.assertRaises(main.ResetterError):
            main.parse_cli_result(output, "haiku")

    def test_interval_is_measured_from_last_attempt(self):
        now = datetime.now(timezone.utc)
        state = {"last_attempt_at": (now - timedelta(hours=1)).isoformat()}
        self.assertAlmostEqual(
            main.seconds_until_due(state, now, 5 * 60 * 60),
            4 * 60 * 60,
            delta=1,
        )


if __name__ == "__main__":
    unittest.main()
