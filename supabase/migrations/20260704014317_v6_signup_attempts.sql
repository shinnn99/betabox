-- V6: bảng rate-limit signup (chống spam từ một nguồn IP/email).
CREATE TABLE public.signup_attempts (
  id bigserial PRIMARY KEY,
  ip inet NOT NULL,
  email text NOT NULL,
  succeeded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_signup_attempts_ip_time
  ON public.signup_attempts (ip, created_at DESC);

CREATE INDEX idx_signup_attempts_email_time
  ON public.signup_attempts (email, created_at DESC);

ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.signup_attempts IS
  'Rate-limit signup từ một nguồn (IP/email). Ngưỡng: 5/IP/giờ, 3/email/ngày. Lớp 2 sau Turnstile captcha. Cleanup 7 ngày.';
