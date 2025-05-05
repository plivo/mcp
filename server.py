from fastmcp.server import FastMCP
import plivo
import os

# Your Plivo credentials
PLIVO_AUTH_ID = os.environ.get("PLIVO_AUTH_ID","")
PLIVO_AUTH_TOKEN = os.environ.get("PLIVO_AUTH_TOKEN","")

# Create Plivo client
client = plivo.RestClient(auth_id=PLIVO_AUTH_ID, auth_token=PLIVO_AUTH_TOKEN)

# Create MCP server
mcp = FastMCP("PlivoMCP")

@mcp.tool()
def send_sms(from_number : str, to_number: str, text: str) -> dict:
    """Send an SMS using Plivo's SDK."""
    try:
        response = client.messages.create(
            src=from_number,
            dst=to_number,
            text=text
        )
        return {
            "message_uuid": response.message_uuid,
            "api_id": response.api_id
        }
    except plivo.exceptions.PlivoRestError as e:
        return {
            "error": str(e)
        }

@mcp.tool()
def make_call(
    from_number: str,
    to_number: str,
    answer_url: str,
    answer_method: str = "GET",
    hangup_url: str = None,
    hangup_method: str = "POST",
    ring_url: str = None,
    ring_method: str = "POST",
    machine_detection: str = None,
    machine_detection_url: str = None,
    machine_detection_method: str = "POST"
) -> dict:
    """
    Initiate a voice call using Plivo's API, with conditional method parameters.

    Parameters:
    - from_number: The Plivo-verified caller ID.
    - to_number: The phone number to call (E.164 format).
    - answer_url: URL Plivo will request to fetch call instructions.
    - answer_method: HTTP method to fetch answer_url (default 'GET').
    - hangup_url: URL called when call ends (optional).
    - ring_url: URL called when call rings (optional).
    - machine_detection_url: URL for machine detection callback (optional).
    - machine_detection: 'true', 'hangup', or None.

    Returns:
    - Dictionary with call UUID and API ID, or error.
    """
    try:
        params = {
            "from_": from_number,
            "to_": to_number,
            "answer_url": answer_url,
            "answer_method": answer_method,
        }

        if hangup_url:
            params["hangup_url"] = hangup_url
            params["hangup_method"] = hangup_method

        if ring_url:
            params["ring_url"] = ring_url
            params["ring_method"] = ring_method

        if machine_detection:
            params["machine_detection"] = machine_detection

        if machine_detection_url:
            params["machine_detection_url"] = machine_detection_url
            params["machine_detection_method"] = machine_detection_method

        response = client.calls.create(**params)

        return {
            "call_uuid": response.request_uuid,
            "api_id": response.api_id
        }
    except plivo.exceptions.PlivoRestError as e:
        return {
            "error": str(e)
        }


@mcp.tool()
def create_application(app_name: str, answer_url: str) -> dict:
    """
    Create a Plivo voice application.

    Parameters:
    - app_name: Name of the application.
    - answer_url: URL that Plivo will invoke with call instructions.

    Returns:
    - Dictionary with app_id or error.
    """
    try:
        response = client.applications.create(
            app_name=app_name,
            answer_url=answer_url,
            answer_method='GET',
            default_endpoint_app=False  # Do not attach to default endpoint automatically
        )
        return {
            "app_id": response.app_id,
            "api_id": response.api_id
        }
    except plivo.exceptions.PlivoRestError as e:
        return {
            "error": str(e)
        }

@mcp.tool()
def create_endpoint(username: str, password: str, alias: str, app_id: str) -> dict:
    """
    Create a Plivo SIP endpoint.

    Parameters:
    - username: The SIP username.
    - password: The SIP password.
    - alias: Friendly name for the endpoint.
    - app_id: Plivo application ID to associate with this endpoint.

    Returns:
    - Dictionary with endpoint_id or error.
    """
    try:
        response = client.endpoints.create(
            username=username,
            password=password,
            alias=alias,
            app_id=app_id
        )
        return {
            "endpoint_id": response.endpoint_id,
            "api_id": response.api_id
        }
    except plivo.exceptions.PlivoRestError as e:
        return {
            "error": str(e)
        }

@mcp.tool()
def get_cdr(call_uuid: str) -> dict:
    """
    Retrieve Call Detail Record (CDR) from Plivo using the call UUID.

    Parameters:
    - call_uuid: The unique identifier of the call.

    Returns:
    - A dictionary containing call details or error message.
    """
    try:
        response = client.calls.get(call_uuid)
        return response.__dict__
    except plivo.exceptions.PlivoRestError as e:
        return {"error": str(e)}

@mcp.tool()
def get_mdr(message_uuid: str) -> dict:
    """
    Retrieve Message Detail Record (MDR) from Plivo using the message UUID.

    Parameters:
    - message_uuid: The unique identifier of the SMS message.

    Returns:
    - A dictionary containing message details or error message.
    """
    try:
        response = client.messages.get(message_uuid)
        return response.__dict__
    except plivo.exceptions.PlivoRestError as e:
        return {"error": str(e)}


if __name__ == "__main__":
    mcp.run()