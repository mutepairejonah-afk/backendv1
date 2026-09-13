-- Payment review and EcoCash settings used by the admin dashboard.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  user_display_name text,
  amount numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ZiG')),
  transaction_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  screenshot_url text,
  approved_by text,
  processed_at timestamptz,
  rejection_reason text,
  dispute_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON public.payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON public.payments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ecocash_settings (
  id integer PRIMARY KEY DEFAULT 1,
  usd_to_zig_rate numeric(10,4) NOT NULL DEFAULT 13.5000,
  ecocash_number text NOT NULL DEFAULT '0788800342',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ecocash_settings (id, usd_to_zig_rate, ecocash_number)
VALUES (1, 13.5, '0788800342')
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-receipts', 'payment-receipts', true)
ON CONFLICT (id) DO UPDATE SET public = excluded.public;
