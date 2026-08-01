from pathlib import Path
import json, sys

ROOT = Path(__file__).resolve().parents[1]
errors = []

requirements = json.loads((ROOT / "requirements/requirements.json").read_text())
req_ids = {r["id"] for r in requirements["requirements"]}

for rel, key in [("permissions/permissions.json","permissions"),("errors/errors.json","errors")]:
    data = json.loads((ROOT / rel).read_text())
    for item in data[key]:
        for rid in item.get("requirementIds", []):
            if rid not in req_ids:
                errors.append(f"{rel}: unknown requirement {rid}")

event = json.loads((ROOT / "events/envelope/domain-event.schema.json").read_text())
required = set(event.get("required", []))
for field in ["eventId","eventType","schemaVersion","aggregateId","payload","requirementIds"]:
    if field not in required:
        errors.append(f"event envelope missing required field {field}")

openapi = (ROOT / "openapi/root.yaml").read_text()
for token in ["openapi: 3.1.0","operationId: createProject","x-requirement-ids","x-grounding-required: true"]:
    if token not in openapi:
        errors.append(f"OpenAPI missing required token: {token}")

if errors:
    print("\n".join(errors))
    sys.exit(1)

print("Release 0 specification validation passed.")
