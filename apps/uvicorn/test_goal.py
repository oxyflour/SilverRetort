import unittest
from pathlib import Path
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import events
from api_routes import chat
from hermes_client import HermesEngine
from models import GoalActionRequest, GoalState, GoalStatusResponse, Message, TextPart


GOAL_PAYLOAD = {
    "objective": "Ship the goal loop",
    "status": "active",
    "turnsUsed": 2,
    "maxTurns": 20,
    "lastVerdict": "continue",
    "lastReason": "More work remains",
    "pausedReason": None,
}


class GoalProtocolTest(unittest.TestCase):
    def test_goal_state_serializes_to_camel_case(self):
        state = GoalState.model_validate(GOAL_PAYLOAD)

        self.assertEqual(state.objective, "Ship the goal loop")
        self.assertEqual(state.model_dump(by_alias=True)["turnsUsed"], 2)

    def test_goal_event_is_session_scoped(self):
        event = events.goal_state("session-a", GOAL_PAYLOAD)

        self.assertEqual(event["type"], "goal-state")
        self.assertEqual(event["sessionId"], "session-a")
        self.assertEqual(event["goal"]["status"], "active")


class GoalRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_get_goal_uses_the_sessions_engine(self):
        engine = type(
            "FakeEngine",
            (),
            {"get_goal": AsyncMock(return_value={"goal": GOAL_PAYLOAD, "message": "active"})},
        )()

        with patch.object(chat, "_goal_engine", return_value=(object(), engine)):
            response = await chat.get_goal("session-a")

        self.assertIsInstance(response, GoalStatusResponse)
        self.assertEqual(response.goal.turns_used, 2)
        engine.get_goal.assert_awaited_once_with("session-a")

    async def test_pause_broadcasts_the_updated_goal(self):
        engine = type(
            "FakeEngine",
            (),
            {
                "goal_command": AsyncMock(
                    return_value={
                        "goal": {**GOAL_PAYLOAD, "status": "paused"},
                        "message": "paused",
                    }
                )
            },
        )()

        with (
            patch.object(chat, "_goal_engine", return_value=(object(), engine)),
            patch.object(chat.events, "broadcast") as broadcast,
        ):
            response = await chat.goal_action(
                "session-a", GoalActionRequest(action="pause")
            )

        self.assertEqual(response.goal.status, "paused")
        engine.goal_command.assert_awaited_once_with("session-a", "/goal pause")
        broadcast.assert_called_once()


class _FakeStreamResponse:
    status_code = 200

    def __init__(self, text):
        self.text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def aiter_lines(self):
        yield "event: response.output_text.delta"
        yield f'data: {{"delta": "{self.text}"}}'
        yield ""
        yield "data: [DONE]"
        yield ""


class _FakeHttpClient:
    prompts = []
    turn = 0

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def stream(self, _method, _url, json, headers):
        self.__class__.prompts.append(json)
        self.__class__.turn += 1
        return _FakeStreamResponse(f"turn-{self.__class__.turn}")


class GoalEngineLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_goal_continues_until_the_judge_finishes(self):
        _FakeHttpClient.prompts = []
        _FakeHttpClient.turn = 0
        engine = HermesEngine("http://hermes", "secret")
        engine.goal_command = AsyncMock(
            return_value={
                "action": "run",
                "prompt": "Finish the feature",
                "goal": {**GOAL_PAYLOAD, "turnsUsed": 0},
            }
        )
        engine.evaluate_goal = AsyncMock(
            side_effect=[
                {
                    "goal": GOAL_PAYLOAD,
                    "shouldContinue": True,
                    "continuationPrompt": "Continue the feature",
                },
                {
                    "goal": {**GOAL_PAYLOAD, "status": "done"},
                    "shouldContinue": False,
                    "continuationPrompt": None,
                },
            ]
        )
        engine.get_goal = AsyncMock(
            return_value={"goal": GOAL_PAYLOAD, "message": "active"}
        )
        message = Message(
            id="user-a",
            session_id="session-a",
            role="user",
            parts=[TextPart(text="/goal Finish the feature")],
            created_at="2026-07-24T00:00:00Z",
        )

        with patch("hermes_client.httpx.AsyncClient", _FakeHttpClient):
            output = [
                event
                async for event in engine.run(
                    "session-a", "workspace-a", [], message
                )
            ]

        self.assertEqual(
            [event["delta"] for event in output if event["kind"] == "text"],
            ["turn-1", "turn-2"],
        )
        self.assertEqual(engine.evaluate_goal.await_count, 2)
        self.assertIn("conversation_history", _FakeHttpClient.prompts[0])
        self.assertNotIn("conversation_history", _FakeHttpClient.prompts[1])


if __name__ == "__main__":
    unittest.main()
