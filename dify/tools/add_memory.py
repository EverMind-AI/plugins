from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.client import EverOSClient, EverOSError
from utils.contracts import validate_add_response, validate_flush_response
from utils.payloads import (
    InputError,
    build_add_payload,
    build_flush_payload,
    project_id,
    runtime_app_id,
    runtime_session_id,
    runtime_user_id,
)


class AddMemoryTool(Tool):
    def _invoke(
        self, tool_parameters: dict[str, Any]
    ) -> Generator[ToolInvokeMessage, None, None]:
        add_started = False
        try:
            project = project_id(self.runtime.credentials)
            app = runtime_app_id(self.session.app_id)
            user_id = runtime_user_id(self.runtime.user_id)
            conversation_id = runtime_session_id(
                self.session.conversation_id or self.runtime.session_id
            )
            add_payload = build_add_payload(
                # Scope identifiers are platform-controlled, not LLM-controlled.
                user_id=user_id,
                conversation_id=conversation_id,
                user_message=tool_parameters.get("user_message"),
                assistant_message=tool_parameters.get("assistant_message"),
                app=app,
                project=project,
            )
            flush_payload = build_flush_payload(
                conversation_id=conversation_id,
                app=app,
                project=project,
            )
            with EverOSClient.from_credentials(self.runtime.credentials) as client:
                add_started = True
                add_response = validate_add_response(client.add(add_payload))
                try:
                    flush_response = validate_flush_response(
                        client.flush(flush_payload)
                    )
                except EverOSError as exc:
                    # The write already succeeded. Return a partial result instead of
                    # raising an ambiguous error that may cause callers to duplicate it.
                    result = {
                        "success": False,
                        "stored": True,
                        "flushed": False,
                        "add": add_response,
                        "flush": {},
                        "error": f"Messages were stored, but flush failed: {exc}",
                    }
                else:
                    result = {
                        "success": True,
                        "stored": True,
                        "flushed": True,
                        "add": add_response,
                        "flush": flush_response,
                        "error": "",
                    }
        except (EverOSError, InputError) as exc:
            if add_started:
                raise RuntimeError(
                    "EverOS add result is unknown; do not retry automatically. "
                    f"Details: {exc}"
                ) from exc
            raise RuntimeError(f"EverOS memory write failed: {exc}") from exc

        for name, value in result.items():
            yield self.create_variable_message(name, value)
        yield self.create_json_message(result)
