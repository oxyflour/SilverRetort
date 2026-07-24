import unittest
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import silverretort_api


class FakeGoalManager:
    def __init__(self, state=None):
        self.state = state

    def status_line(self):
        return "No active goal." if self.state is None else f"Goal: {self.state.goal}"

    def set(self, objective):
        self.state = SimpleNamespace(
            goal=objective,
            status="active",
            turns_used=0,
            max_turns=20,
            last_verdict=None,
            last_reason=None,
            paused_reason=None,
        )

    def pause(self, reason="user-paused"):
        if self.state:
            self.state.status = "paused"
            self.state.paused_reason = reason

    def resume(self):
        if self.state:
            self.state.status = "active"
        return self.state

    def clear(self):
        self.state = None

    def next_continuation_prompt(self):
        return f"Continue: {self.state.goal}" if self.state else None

    def evaluate_after_turn(self, response):
        self.state.status = "done"
        self.state.last_verdict = "done"
        self.state.last_reason = response
        return {
            "should_continue": False,
            "continuation_prompt": None,
            "verdict": "done",
            "reason": response,
            "message": "done",
        }


class GoalApiTest(unittest.TestCase):
    def test_setting_a_goal_starts_with_the_plain_objective(self):
        manager = FakeGoalManager()
        with patch.object(silverretort_api, "_goal_manager", return_value=manager):
            response = silverretort_api.handle_goal_command(
                "/goal Finish the feature", "silverretort:session-a"
            )

        self.assertTrue(response["handled"])
        self.assertEqual(response["action"], "run")
        self.assertEqual(response["prompt"], "Finish the feature")
        self.assertEqual(response["goal"]["status"], "active")

    def test_pause_is_control_only(self):
        manager = FakeGoalManager()
        manager.set("Finish the feature")
        with patch.object(silverretort_api, "_goal_manager", return_value=manager):
            response = silverretort_api.handle_goal_command(
                "/goal pause", "silverretort:session-a"
            )

        self.assertEqual(response["action"], "control")
        self.assertEqual(response["goal"]["status"], "paused")

    def test_subcommand_prefix_can_still_be_part_of_an_objective(self):
        manager = FakeGoalManager()
        with patch.object(silverretort_api, "_goal_manager", return_value=manager):
            response = silverretort_api.handle_goal_command(
                "/goal Status page implementation", "silverretort:session-a"
            )

        self.assertEqual(response["action"], "run")
        self.assertEqual(response["prompt"], "Status page implementation")

    def test_stop_clears_the_goal(self):
        manager = FakeGoalManager()
        manager.set("Finish the feature")
        with patch.object(silverretort_api, "_goal_manager", return_value=manager):
            response = silverretort_api.handle_goal_command(
                "/goal stop", "silverretort:session-a"
            )

        self.assertEqual(response["action"], "control")
        self.assertIsNone(response["goal"])

    def test_evaluate_returns_done_state(self):
        manager = FakeGoalManager()
        manager.set("Finish the feature")
        with patch.object(silverretort_api, "_goal_manager", return_value=manager):
            response = silverretort_api.evaluate_goal(
                "silverretort:session-a", "Everything passed"
            )

        self.assertFalse(response["shouldContinue"])
        self.assertEqual(response["verdict"], "done")
        self.assertEqual(response["goal"]["status"], "done")


if __name__ == "__main__":
    unittest.main()
