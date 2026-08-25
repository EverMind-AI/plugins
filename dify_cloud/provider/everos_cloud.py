from collections.abc import Mapping
from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from utils.client import EverOSClient, EverOSError


class EverOSCloudProvider(ToolProvider):
    def _validate_credentials(self, credentials: Mapping[str, Any]) -> None:
        try:
            with EverOSClient.from_credentials(credentials) as client:
                client.health()
        except (EverOSError, ValueError) as exc:
            raise ToolProviderCredentialValidationError(str(exc)) from exc
