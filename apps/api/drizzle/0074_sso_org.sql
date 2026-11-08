-- S-72: the organisation of a provider sign-in (Google hd / Microsoft tid), checked against the account SSO policy.
ALTER TABLE "auth_sessions" ADD COLUMN "sign_in_org" varchar(200);