# Manual POSTMAN API Testing

## Register

> POST `http://localhost:4000/api/auth/register`

```json
{
  "email": "pm@test.com",
  "password": "password123",
  "full_name": "Project Manager",
  "role": "pm"
}
```

## Login

> POST `https://avhupwhzzatvfjcadxso.supabase.co/auth/v1/token?grant_type=password`

```json
{
  "email": "pm@test.com",
  "password": "password123"
}
```

## Create Project

> POST `http://localhost:4000/api/projects`

```json
{
  "name": "Autonomous Warehouse Robot System",
  "description": "A fleet of automated robots designed to navigate warehouse floors, retrieve pallets, and deliver them to sorting stations.",
  "client_id": "69592629-4f4f-430a-a0bd-6e90b4ca41bc"
}
```

## Create Requirements

> POST `http://localhost:4000/api/requirements`

```json
// {
//     "project_id": "de07894f-3f2d-4f6c-a4ee-504f6c2063a0",
//     "title": "Automated Charging",
//     "description": "The robot must monitor its own battery levels and autonomously return to a charging dock when below 15%."
// }

// {
//     "new_status": "SUBMITTED"
// }

{
  "new_status": "UNDER_ANALYSIS"
}
```

## Create Specifications

> POST `http://localhost:4000/api/requirements/{:requirement_id}/specs`

```json
{
  "title": "Encrypted Data Transmission",
  "description": "All telemetry and dispatch commands must be encrypted using TLS 1.3 to prevent unauthorized interception or hijacking.",
  "acceptance_criteria": "Penetration tests must confirm zero unencrypted packet leakage during standard operations.",
  "complexity_score": 7
}
```

## Create Tasks (Manual)

> POST `http://localhost:4000/api/tasks`

```json
{
  "requirement_id": "401f829d-61ac-4198-b7b9-cdf500bc7cff",
  "title": "Task 2",
  "description": "task 2 desc",
  "estimated_hours": 5,
  "priority": "HIGH"
}
```

## Create Task Dependencies (Manual)

> POST `http://localhost:4000/api/tasks/dependencies`

```json
{
  "depends_on_task_id": "4a527891-d993-439c-a253-dc86994025c6",
  "task_id": "c7cea924-152f-4073-8c49-381763b626e1"
}
```

## WBS LLM Generation

> POST `http://localhost:4000/api/projects/{:project_id}/generate-wbs`

> POST `http://localhost:4000/api/projects/{:project_id}/persist-wbs`

```json
{
  "tasks": [
    {
      "temp_id": "t1",
      "requirement_id": "a3b4e655-36c4-4c91-9b09-78499997652a",
      "title": "Implement MQTT Client for Telemetry",
      "description": "Develop and integrate a lightweight MQTT client to broadcast robot's X/Y coordinates and battery status to the central server",
      "estimated_hours": 8,
      "priority": "HIGH",
      "depends_on_temp_ids": [],
      "depends_on_existing_task_ids": ["2f12f17f-b5bf-4ac9-8185-865f724beda7"],
      "is_ai_generated": true
    },
    {
      "temp_id": "t2",
      "requirement_id": "a3b4e655-36c4-4c91-9b09-78499997652a",
      "title": "Install Dual-Band Wi-Fi & 5G Module",
      "description": "Install a dual-band network module with automatic failover between local warehouse Wi-Fi and a backup cellular 5G network",
      "estimated_hours": 4,
      "priority": "MEDIUM",
      "depends_on_temp_ids": [],
      "depends_on_existing_task_ids": [],
      "is_ai_generated": true
    },
    {
      "temp_id": "t3",
      "requirement_id": "a3b4e655-36c4-4c91-9b09-78499997652a",
      "title": "Implement TLS 1.3 Encryption for Data Transmission",
      "description": "Integrate TLS 1.3 encryption for all telemetry and dispatch commands to prevent unauthorized interception or hijacking",
      "estimated_hours": 6,
      "priority": "HIGH",
      "depends_on_temp_ids": ["t1", "t2"],
      "depends_on_existing_task_ids": [],
      "is_ai_generated": true
    }
  ],
  "message": "Review and edit these AI-generated project tasks before saving."
}
```
