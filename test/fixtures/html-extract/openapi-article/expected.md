## Send a message to a customer

Use the Messages API to send a message into an open conversation. The full list of fields is in the [Messages API reference](https://help.acme.test/reference/messages).

### Request

```
POST /v1/messages
Authorization: Bearer <token>
Content-Type: application/json
```

### Body

```json
{
  "conversation": "c_1042",
  "text": "Fish & chips are ready",
  "notify": true
}
```

The same call from a shell:

```bash
curl -X POST https://api.acme.test/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -d @message.json
```

### Parameters

| Field | Type | Notes |
| --- | --- | --- |
| conversation | string | The id of an open conversation |
| text | string | The message body, up to 4000 characters |
| notify | boolean | Send the customer a notification |
