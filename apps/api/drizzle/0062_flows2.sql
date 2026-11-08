-- flows2: a failure the flow ran fine again after (`flow_recovered` automations).
ALTER TABLE "flow_failure_alerts" ADD COLUMN "recovered_at" timestamp with time zone;
