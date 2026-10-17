create role anon;create role authenticated;create role service_role bypassrls;
create table actors(id uuid primary key,name text,system_prompt text,review_mode text);
create table chats(id uuid primary key,actor_id uuid references actors,title text,created_at timestamptz,updated_at timestamptz);
create table messages(id uuid primary key,actor_id uuid references actors,chat_id uuid references chats,role text,content text,created_at timestamptz);
create table chat_requests(request_id text primary key,actor_id text,chat_id text,status text,error_message text,updated_at timestamptz);
create table repo_sync_runs(id uuid primary key,repository_full_name text,created_at timestamptz default now());
grant usage on schema public to service_role;grant select,insert,update on actors,chats,messages,chat_requests,repo_sync_runs to service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
