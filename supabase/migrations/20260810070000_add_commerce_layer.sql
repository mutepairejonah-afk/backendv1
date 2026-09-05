-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — Economic layer: in-chat commerce + org payroll payouts
-- Run AFTER 20260810061020_add_organizations.sql and
-- 20260810061500_add_security_layer.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Catalog ───────────────────────────────────────────────────────────────────
create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'USD',
  image_url text,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_catalog_items_org on catalog_items(organization_id, active);

-- ── Orders ────────────────────────────────────────────────────────────────────
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_clerk_id text not null,
  conversation_id uuid references conversations(id) on delete set null,
  status text not null default 'pending',   -- 'pending' | 'paid' | 'fulfilled' | 'cancelled'
  total_cents integer not null default 0,
  currency text not null default 'USD',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_org on orders(organization_id, status);
create index if not exists idx_orders_customer on orders(customer_clerk_id);
create index if not exists idx_orders_conversation on orders(conversation_id);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  catalog_item_id uuid references catalog_items(id) on delete set null,
  name_snapshot text not null,        -- captured at order time, survives catalog edits
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0)
);

create index if not exists idx_order_items_order on order_items(order_id);

-- ── Invoices / payment verification (reuses the EcoCash manual-verify pattern
--    already used for premium subscriptions in `payments`) ────────────────────
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  amount_cents integer not null,
  currency text not null default 'USD',
  ecocash_reference text,
  screenshot_url text,
  status text not null default 'pending',   -- 'pending' | 'verified' | 'rejected'
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_order on invoices(order_id);
create index if not exists idx_invoices_status on invoices(status);

-- ── Org payroll payouts (internal economic layer — admins pay members) ──────
create table if not exists payroll_payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  recipient_clerk_id text not null,
  initiated_by text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  reason text,                                -- 'salary' | 'reimbursement' | 'bonus' | free text
  ecocash_reference text,
  status text not null default 'pending',     -- 'pending' | 'paid' | 'failed'
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists idx_payroll_org on payroll_payouts(organization_id, status);
create index if not exists idx_payroll_recipient on payroll_payouts(recipient_clerk_id);

-- ── Link messages to orders (mirrors the existing messages.poll_id pattern) ──
alter table messages add column if not exists order_id uuid references orders(id) on delete set null;
create index if not exists idx_messages_order on messages(order_id);

-- ── updated_at triggers (reuses set_updated_at() from the org migration) ────
drop trigger if exists trg_catalog_items_updated_at on catalog_items;
create trigger trg_catalog_items_updated_at
  before update on catalog_items
  for each row execute function set_updated_at();

drop trigger if exists trg_orders_updated_at on orders;
create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ── Storage bucket for catalog product images ────────────────────────────────
insert into storage.buckets (id, name, public)
values ('catalog-images', 'catalog-images', true)
on conflict (id) do nothing;

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table catalog_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table invoices enable row level security;
alter table payroll_payouts enable row level security;

drop policy if exists catalog_items_select on catalog_items;
create policy catalog_items_select on catalog_items for select
  using (active = true or exists (
    select 1 from organization_members m
    where m.organization_id = catalog_items.organization_id
      and m.clerk_user_id = auth.jwt()->>'sub'
  ));

drop policy if exists orders_select_own on orders;
create policy orders_select_own on orders for select
  using (
    customer_clerk_id = auth.jwt()->>'sub'
    or exists (
      select 1 from organization_members m
      where m.organization_id = orders.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists payroll_select_own on payroll_payouts;
create policy payroll_select_own on payroll_payouts for select
  using (
    recipient_clerk_id = auth.jwt()->>'sub'
    or exists (
      select 1 from organization_members m
      where m.organization_id = payroll_payouts.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- As with prior migrations: writes go through the backend's service-role
-- key and bypass RLS; these policies protect any direct client reads.
