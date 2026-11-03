create table posts (
  id uuid primary key,
  author uuid references profiles (id)
);

alter table posts enable row level security;

create policy "authors read own posts" on posts for select using (auth.uid() = author);
