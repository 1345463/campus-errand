-- Run after add-admin-roles.sql (and other existing migrations).
-- The configured password is represented only by a salted digest here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_password_settings (
  id integer PRIMARY KEY CHECK(id=1),
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_password_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_password_settings FROM PUBLIC, anon, authenticated;

INSERT INTO public.admin_password_settings(id,password_salt,password_hash)
VALUES(1,'fe12d78fefaa7254a8b06d452fc971d59c2ae2bca285e21f',
  '9ed0786a5e57fde25bb2d9619e6fcea04d69c9cad79702bc1eaf696687caf900')
ON CONFLICT(id) DO UPDATE SET password_salt=EXCLUDED.password_salt,
  password_hash=EXCLUDED.password_hash,updated_at=now();

CREATE TABLE IF NOT EXISTS public.admin_password_attempts (
  user_id text PRIMARY KEY,
  window_started timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.admin_password_audit (
  id bigserial PRIMARY KEY,user_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_password_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_password_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_password_attempts,public.admin_password_audit FROM PUBLIC, anon, authenticated;

-- The old function definition is absent from the repository. Recreate its public
-- one-argument contract explicitly, avoiding unknown production return types.
DROP FUNCTION IF EXISTS public.activate_admin(text);
CREATE FUNCTION public.activate_admin(p_code text)
RETURNS SETOF public.profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := NULLIF(auth.uid(),'');
  v_salt text; v_hash text; v_failures integer; v_profile public.profiles;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.owner_id=v_uid) THEN
    RAISE EXCEPTION '用户资料不存在，请重新登录';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-password:'||v_uid,0));
  SELECT s.password_salt,s.password_hash INTO v_salt,v_hash
    FROM public.admin_password_settings s WHERE s.id=1;
  IF v_hash IS NULL THEN RAISE EXCEPTION '后台密码尚未配置'; END IF;
  INSERT INTO public.admin_password_attempts(user_id) VALUES(v_uid) ON CONFLICT(user_id) DO NOTHING;
  UPDATE public.admin_password_attempts a SET failures=0,window_started=now()
    WHERE a.user_id=v_uid AND a.window_started<=now()-interval '15 minutes';
  SELECT a.failures INTO v_failures FROM public.admin_password_attempts a WHERE a.user_id=v_uid;
  IF v_failures>=5 THEN RAISE EXCEPTION '密码尝试次数过多，请在 15 分钟后重试'; END IF;
  IF encode(sha256(convert_to(v_salt||':'||btrim(COALESCE(p_code,'')),'UTF8')),'hex')<>v_hash THEN
    UPDATE public.admin_password_attempts a SET failures=a.failures+1 WHERE a.user_id=v_uid;
    -- Empty result deliberately commits the failed-attempt counter. Raising here
    -- would roll back that write and make rate limiting ineffective.
    RETURN;
  END IF;
  INSERT INTO public.admin_grants(user_id,perm_key,granted_by)
    VALUES(v_uid,'super',v_uid) ON CONFLICT(user_id,perm_key) DO NOTHING;
  UPDATE public.profiles p SET is_admin=true WHERE p.owner_id=v_uid RETURNING p.* INTO v_profile;
  DELETE FROM public.admin_password_attempts a WHERE a.user_id=v_uid;
  INSERT INTO public.admin_password_audit(user_id) VALUES(v_uid);
  RETURN NEXT v_profile;
END;
$fn$;
REVOKE ALL ON FUNCTION public.activate_admin(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_admin(text) TO authenticated;
COMMIT;
