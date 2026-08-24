from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.client import EverOSClient, EverOSError
from utils.contracts import validate_search_response
from utils.payloads import (
    InputError,
    build_search_payload,
    project_id,
    runtime_app_id,
    runtime_user_id,
)


class SearchMemoryTool(Tool):
    def _invoke(
        self, tool_parameters: dict[str, Any]
    ) -> Generator[ToolInvokeMessage, None, None]:
        try:
            project = project_id(self.runtime.credentials)
            app = runtime_app_id(self.session.app_id)
            payload = build_search_payload(
                # Memory ownership comes from Dify, never from an LLM argument.
                user_id=runtime_user_id(self.runtime.user_id),
                query=tool_parameters.get("query"),
                limit=tool_parameters.get("top_k"),
                app=app,
                project=project,
            )
            with EverOSClient.from_credentials(self.runtime.credentials) as client:
                response = client.search(payload)
            result = validate_search_response(response)
        except (EverOSError, InputError) as exc:
            raise RuntimeError(f"EverOS memory search failed: {exc}") from exc

        for name, value in result.items():
            yield self.create_variable_message(name, value)
        yield self.create_json_message(result)
