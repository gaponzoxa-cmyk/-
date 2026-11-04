-- ═══════════════════════════════════════════════════════════════════════════
--  «Касса» — учёт овощного магазина. Начальная схема.
--
--  Деньги — bigint в копейках (*_kop). Количество — numeric(10,3).
--  Сумма строки = round(кол-во × цена) — round для numeric в Postgres
--  округляет половину от нуля, так же как src/lib/money.ts.
--
--  Каждая строка привязана к shop_id; доступ проверяется политиками RLS.
--  Роли: owner (всё), seller (касса/расходы/списания/долги, БЕЗ закупочных
--  цен и заработка), viewer (только чтение всего).
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─────────────────────────── Типы ───────────────────────────
create type public.member_role as enum ('owner', 'seller', 'viewer');
create type public.unit_kind   as enum ('kg', 'pcs');
-- откуда оплачена закупка: наличные из кассы / свои деньги / карта (счёт ФОП)
create type public.pay_source  as enum ('cash_register', 'own', 'card');
-- как введена закупка: ценой за единицу или общей суммой
create type public.buy_input   as enum ('price', 'sum');
create type public.debt_kind   as enum ('credit', 'repayment');
create type public.money_channel as enum ('cash', 'terminal');

-- ─────────────────────────── Магазины и участники ───────────────────────────
create table public.shops (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(trim(name)) > 0),
  low_markup_pct     numeric(6,2) not null default 30,   -- порог «низкой наценки»
  price_round_kop    integer      not null default 100 check (price_round_kop > 0), -- шаг округления цены продажи
  price_jump_pct     numeric(6,2) not null default 20,   -- предупреждение о скачке цены закупки
  default_markup_pct numeric(6,2) not null default 30,
  created_at         timestamptz  not null default now()
);

create table public.shop_members (
  shop_id      uuid not null references public.shops(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         public.member_role not null,
  display_name text,
  created_at   timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index on public.shop_members (user_id);

-- Проверки прав. security definer — чтобы не зациклить RLS на shop_members.
create or replace function public.member_role_of(p_shop uuid)
returns public.member_role
language sql stable security definer set search_path = public
as $$
  select role from public.shop_members where shop_id = p_shop and user_id = auth.uid()
$$;

create or replace function public.is_member(p_shop uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.member_role_of(p_shop) is not null $$;

create or replace function public.is_owner(p_shop uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.member_role_of(p_shop) = 'owner' $$;

-- может ли видеть закупочные цены и заработок
create or replace function public.can_see_costs(p_shop uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.member_role_of(p_shop) in ('owner', 'viewer') $$;

-- может ли вносить кассу, расходы, списания, долги
create or replace function public.can_enter(p_shop uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.member_role_of(p_shop) in ('owner', 'seller') $$;

-- ─────────────────────────── Общие триггеры ───────────────────────────
create or replace function public.tg_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ─────────────────────────── Справочники ───────────────────────────
create table public.categories (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  name              text not null check (length(trim(name)) > 0),
  target_markup_pct numeric(6,2),          -- целевая наценка категории
  loss_norm_pct     numeric(6,2),          -- норма потерь, % от закупки
  sort              integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  deleted_at        timestamptz
);
create unique index categories_name_uq on public.categories (shop_id, lower(name)) where deleted_at is null;

create table public.products (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  name              text not null check (length(trim(name)) > 0),
  unit              public.unit_kind not null default 'kg',
  category_id       uuid references public.categories(id) on delete set null,
  target_markup_pct numeric(6,2),          -- своя наценка (если пусто — берётся из категории/магазина)
  max_normal_qty    numeric(10,3),         -- «обычно не больше» — для предупреждений
  active            boolean not null default true,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  deleted_at        timestamptz
);
create unique index products_name_uq on public.products (shop_id, lower(name)) where deleted_at is null;

create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  phone      text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz
);
create unique index suppliers_name_uq on public.suppliers (shop_id, lower(name)) where deleted_at is null;

create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  phone      text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz
);
create unique index customers_name_uq on public.customers (shop_id, lower(name)) where deleted_at is null;

-- ─────────────────────────── Приход товара ───────────────────────────
-- id может создать телефон (uuid) — повторная отправка из офлайн-очереди
-- не создаст дубль.
create table public.purchases (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  day           date not null,
  product_id    uuid not null references public.products(id),
  supplier_id   uuid references public.suppliers(id),
  qty           numeric(10,3) not null check (qty > 0),
  unit          public.unit_kind not null,
  buy_input     public.buy_input not null default 'price',
  buy_price_kop bigint not null check (buy_price_kop >= 0),
  buy_sum_kop   bigint not null check (buy_sum_kop >= 0),
  sell_price_kop bigint not null check (sell_price_kop >= 0),
  sell_sum_kop  bigint generated always as (round(qty * sell_price_kop)::bigint) stored,
  pay_source    public.pay_source not null default 'cash_register',
  comment       text,
  position      integer not null default 0,     -- порядок в дне (хронология)
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  deleted_at    timestamptz
);
create index purchases_day_idx on public.purchases (shop_id, day) where deleted_at is null;
create index purchases_product_idx on public.purchases (shop_id, product_id, day);

-- Пересчёт суммы/цены закупки — единое правило для всех способов ввода.
create or replace function public.tg_purchases_compute()
returns trigger language plpgsql as $$
begin
  if new.buy_input = 'sum' then
    -- ввели общую сумму — цену за единицу считаем, сумму оставляем как есть
    new.buy_price_kop := round(new.buy_sum_kop / new.qty)::bigint;
  else
    new.buy_sum_kop := round(new.qty * new.buy_price_kop)::bigint;
  end if;
  return new;
end $$;

-- чтобы insert мог не передавать buy_sum_kop/buy_price_kop
alter table public.purchases alter column buy_sum_kop set default 0;
alter table public.purchases alter column buy_price_kop set default 0;

create trigger purchases_compute before insert or update on public.purchases
  for each row execute function public.tg_purchases_compute();
create trigger purchases_touch before update on public.purchases
  for each row execute function public.tg_touch();

-- ─────────────────────────── Касса дня ───────────────────────────
create table public.cash_days (
  shop_id            uuid not null references public.shops(id) on delete cascade,
  day                date not null,
  cash_evening_kop   bigint check (cash_evening_kop >= 0),   -- наличные в кассе вечером (пересчёт)
  terminal_kop       bigint check (terminal_kop >= 0),       -- терминал за день
  cash_morning_kop   bigint check (cash_morning_kop >= 0),   -- если пусто — берётся вчерашний вечер
  from_card_kop      bigint not null default 0 check (from_card_kop >= 0),   -- снял с карты в кассу
  taken_by_owner_kop bigint not null default 0 check (taken_by_owner_kop >= 0), -- забрал из кассы себе
  comment            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  primary key (shop_id, day)
);
create trigger cash_days_touch before update on public.cash_days
  for each row execute function public.tg_touch();

-- ─────────────────────────── Расходы ───────────────────────────
create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  day           date not null,
  category      text not null default 'Прочее',
  amount_kop    bigint not null check (amount_kop > 0),
  from_register boolean not null default true,   -- оплачено наличными из кассы
  comment       text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  deleted_at    timestamptz
);
create index expenses_day_idx on public.expenses (shop_id, day) where deleted_at is null;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.tg_touch();

create table public.recurring_expenses (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  name         text not null,
  amount_kop   bigint not null check (amount_kop >= 0),
  day_of_month integer check (day_of_month between 1 and 31), -- срок оплаты (для платёжного календаря)
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  deleted_at   timestamptz
);
create trigger recurring_touch before update on public.recurring_expenses
  for each row execute function public.tg_touch();

-- ─────────────────────────── Списания ───────────────────────────
create table public.writeoffs (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  day           date not null,
  product_id    uuid not null references public.products(id),
  qty           numeric(10,3) not null check (qty > 0),
  unit_cost_kop bigint not null default 0,  -- цена закупки (берёт сервер)
  sum_kop       bigint not null default 0,
  reason        text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  deleted_at    timestamptz
);
create index writeoffs_day_idx on public.writeoffs (shop_id, day) where deleted_at is null;

-- Цена списания = последняя цена закупки этого товара на эту дату или раньше.
create or replace function public.tg_writeoffs_compute()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select p.buy_price_kop into new.unit_cost_kop
    from public.purchases p
   where p.shop_id = new.shop_id and p.product_id = new.product_id
     and p.day <= new.day and p.deleted_at is null
   order by p.day desc, p.created_at desc
   limit 1;
  new.unit_cost_kop := coalesce(new.unit_cost_kop, 0);
  new.sum_kop := round(new.qty * new.unit_cost_kop)::bigint;
  return new;
end $$;
create trigger writeoffs_compute before insert or update of qty, product_id, day on public.writeoffs
  for each row execute function public.tg_writeoffs_compute();
create trigger writeoffs_touch before update on public.writeoffs
  for each row execute function public.tg_touch();

-- ─────────────────────────── Долги покупателей ───────────────────────────
create table public.customer_debts (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  day         date not null,
  customer_id uuid not null references public.customers(id),
  kind        public.debt_kind not null,          -- credit = взял в долг, repayment = вернул
  amount_kop  bigint not null check (amount_kop > 0),
  channel     public.money_channel not null default 'cash', -- как вернул
  comment     text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  deleted_at  timestamptz
);
create index customer_debts_day_idx on public.customer_debts (shop_id, day) where deleted_at is null;
create trigger customer_debts_touch before update on public.customer_debts
  for each row execute function public.tg_touch();

create trigger categories_touch before update on public.categories for each row execute function public.tg_touch();
create trigger products_touch   before update on public.products   for each row execute function public.tg_touch();
create trigger suppliers_touch  before update on public.suppliers  for each row execute function public.tg_touch();
create trigger customers_touch  before update on public.customers  for each row execute function public.tg_touch();

-- ─────────────────────────── Журнал изменений ───────────────────────────
create table public.audit_log (
  id        bigint generated always as identity primary key,
  shop_id   uuid not null,
  tbl       text not null,
  row_id    text not null,
  action    text not null,           -- insert / update / delete
  old_data  jsonb,
  new_data  jsonb,
  user_id   uuid default auth.uid(),
  at        timestamptz not null default now()
);
create index audit_log_shop_idx on public.audit_log (shop_id, at desc);

create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  rid text;
begin
  r := to_jsonb(coalesce(new, old));
  rid := coalesce(r->>'id', (r->>'shop_id') || ':' || (r->>'day'));
  insert into public.audit_log (shop_id, tbl, row_id, action, old_data, new_data)
  values (
    (r->>'shop_id')::uuid, tg_table_name, rid, lower(tg_op),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['purchases','cash_days','expenses','writeoffs','customer_debts',
                           'products','suppliers','customers','categories','recurring_expenses']
  loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function public.tg_audit()', t || '_audit', t);
  end loop;
end $$;

-- ═══════════════════════════ Права доступа (RLS) ═══════════════════════════
alter table public.shops              enable row level security;
alter table public.shop_members       enable row level security;
alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.suppliers          enable row level security;
alter table public.customers          enable row level security;
alter table public.purchases          enable row level security;
alter table public.cash_days          enable row level security;
alter table public.expenses           enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.writeoffs          enable row level security;
alter table public.customer_debts     enable row level security;
alter table public.audit_log          enable row level security;

-- магазины
create policy shops_select on public.shops for select using (public.is_member(id));
create policy shops_update on public.shops for update using (public.is_owner(id)) with check (public.is_owner(id));

-- участники: видят состав своего магазина, меняет только владелец
create policy members_select on public.shop_members for select using (public.is_member(shop_id));
create policy members_write  on public.shop_members for all
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));

-- справочники: читают все участники; товары/поставщиков могут добавлять продавцы
create policy categories_select on public.categories for select using (public.is_member(shop_id));
create policy categories_write  on public.categories for all
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));

create policy products_select on public.products for select using (public.is_member(shop_id));
create policy products_insert on public.products for insert with check (public.can_enter(shop_id));
create policy products_update on public.products for update
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));
create policy products_delete on public.products for delete using (public.is_owner(shop_id));

create policy suppliers_select on public.suppliers for select using (public.is_member(shop_id));
create policy suppliers_insert on public.suppliers for insert with check (public.can_enter(shop_id));
create policy suppliers_update on public.suppliers for update
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));
create policy suppliers_delete on public.suppliers for delete using (public.is_owner(shop_id));

create policy customers_select on public.customers for select using (public.is_member(shop_id));
create policy customers_insert on public.customers for insert with check (public.can_enter(shop_id));
create policy customers_update on public.customers for update
  using (public.can_enter(shop_id)) with check (public.can_enter(shop_id));

-- закупки: таблицу целиком видят только владелец и наблюдатель.
-- Продавец добавляет закупки через add_purchase_seller() и видит их через
-- seller_purchases() — без цен и сумм закупки.
create policy purchases_select on public.purchases for select using (public.can_see_costs(shop_id));
create policy purchases_insert on public.purchases for insert with check (public.is_owner(shop_id));
create policy purchases_update on public.purchases for update
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));
create policy purchases_delete on public.purchases for delete using (public.is_owner(shop_id));

-- касса: вносят владелец и продавец, читают все участники
create policy cash_select on public.cash_days for select using (public.is_member(shop_id));
create policy cash_insert on public.cash_days for insert with check (public.can_enter(shop_id));
create policy cash_update on public.cash_days for update
  using (public.can_enter(shop_id)) with check (public.can_enter(shop_id));

-- расходы
create policy expenses_select on public.expenses for select using (public.is_member(shop_id));
create policy expenses_insert on public.expenses for insert with check (public.can_enter(shop_id));
create policy expenses_update on public.expenses for update
  using (public.is_owner(shop_id) or (public.can_enter(shop_id) and created_by = auth.uid()))
  with check (public.can_enter(shop_id));

create policy recurring_select on public.recurring_expenses for select using (public.can_see_costs(shop_id));
create policy recurring_write  on public.recurring_expenses for all
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));

-- списания: сумма по цене закупки раскрывает цену, поэтому продавец
-- читает их через seller_writeoffs() (без сумм).
create policy writeoffs_select on public.writeoffs for select using (public.can_see_costs(shop_id));
create policy writeoffs_insert on public.writeoffs for insert with check (public.can_enter(shop_id));
create policy writeoffs_update on public.writeoffs for update
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));

-- долги покупателей
create policy debts_select on public.customer_debts for select using (public.is_member(shop_id));
create policy debts_insert on public.customer_debts for insert with check (public.can_enter(shop_id));
create policy debts_update on public.customer_debts for update
  using (public.is_owner(shop_id) or (public.can_enter(shop_id) and created_by = auth.uid()))
  with check (public.can_enter(shop_id));

-- журнал: только владелец
create policy audit_select on public.audit_log for select using (public.is_owner(shop_id));

-- Физическое удаление строк запрещено всем, кроме очистки корзины:
-- «удалить» = поставить deleted_at (корзина на 30 дней).

-- ═══════════════════════════ Функции для приложения ═══════════════════════════

-- Создать магазин (первый вход владельца). Создатель становится owner.
create or replace function public.create_shop(p_name text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
begin
  if auth.uid() is null then
    raise exception 'Нужно войти в приложение';
  end if;
  insert into public.shops (name) values (trim(p_name)) returning id into v_shop;
  insert into public.shop_members (shop_id, user_id, role, display_name)
    values (v_shop, auth.uid(), 'owner', p_display_name);
  insert into public.categories (shop_id, name, target_markup_pct, loss_norm_pct, sort) values
    (v_shop, 'Базовые овощи', 35, 3, 1),
    (v_shop, 'Овощи',         30, 5, 2),
    (v_shop, 'Фрукты',        30, 5, 3),
    (v_shop, 'Ягоды',         30, 10, 4),
    (v_shop, 'Зелень',        40, 15, 5),
    (v_shop, 'Экзотика',      30, 7, 6),
    (v_shop, 'Прочее',        30, 2, 7);
  insert into public.recurring_expenses (shop_id, name, amount_kop) values
    (v_shop, 'Аренда',   800000),
    (v_shop, 'Свет',     150000),
    (v_shop, 'Продавец', 1500000);
  return v_shop;
end $$;

-- Закупка от продавца: цены видит только при вводе, после сохранения — нет.
create or replace function public.add_purchase_seller(
  p_id uuid, p_shop uuid, p_day date, p_product uuid, p_supplier uuid,
  p_qty numeric, p_unit public.unit_kind, p_buy_input public.buy_input,
  p_buy_price_kop bigint, p_buy_sum_kop bigint, p_sell_price_kop bigint,
  p_pay_source public.pay_source, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_enter(p_shop) then
    raise exception 'Нет прав вносить закупки в этом магазине';
  end if;
  insert into public.purchases (id, shop_id, day, product_id, supplier_id, qty, unit, buy_input,
                                buy_price_kop, buy_sum_kop, sell_price_kop, pay_source, comment, created_by)
  values (coalesce(p_id, gen_random_uuid()), p_shop, p_day, p_product, p_supplier, p_qty, p_unit, p_buy_input,
          coalesce(p_buy_price_kop, 0), coalesce(p_buy_sum_kop, 0), p_sell_price_kop, p_pay_source, p_comment, auth.uid())
  on conflict (id) do nothing;
end $$;

-- Закупки дня для продавца — без цен и сумм закупки.
create or replace function public.seller_purchases(p_shop uuid, p_day date)
returns table (id uuid, product_id uuid, product_name text, supplier_name text,
               qty numeric, unit public.unit_kind, sell_price_kop bigint,
               pay_source public.pay_source, paid_cash_kop bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.product_id, pr.name, s.name, p.qty, p.unit, p.sell_price_kop, p.pay_source,
         -- сколько отдано из кассы — нужно продавцу для сверки кассы
         case when p.pay_source = 'cash_register' then p.buy_sum_kop else 0 end,
         p.created_at
    from public.purchases p
    join public.products pr on pr.id = p.product_id
    left join public.suppliers s on s.id = p.supplier_id
   where p.shop_id = p_shop and p.day = p_day and p.deleted_at is null
     and public.is_member(p_shop)
   order by p.position, p.created_at
$$;

create or replace function public.seller_writeoffs(p_shop uuid, p_day date)
returns table (id uuid, product_id uuid, product_name text, qty numeric, reason text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select w.id, w.product_id, pr.name, w.qty, w.reason, w.created_at
    from public.writeoffs w join public.products pr on pr.id = w.product_id
   where w.shop_id = p_shop and w.day = p_day and w.deleted_at is null
     and public.is_member(p_shop)
   order by w.created_at
$$;

-- ═══════════════════════════ Итоги ═══════════════════════════
-- Итоги по дням. security_invoker — права проверяются как у того, кто спрашивает,
-- поэтому продавец получит пустые закупочные суммы (purchases ему не видна).
create or replace view public.day_totals with (security_invoker = true) as
with days as (
  select shop_id, day from public.purchases where deleted_at is null
  union select shop_id, day from public.cash_days
  union select shop_id, day from public.expenses where deleted_at is null
  union select shop_id, day from public.writeoffs where deleted_at is null
  union select shop_id, day from public.customer_debts where deleted_at is null
),
pur as (
  select shop_id, day,
         count(*)::int                         as purchase_count,
         sum(buy_sum_kop)::bigint              as buy_kop,
         sum(sell_sum_kop)::bigint             as sell_kop,
         sum(buy_sum_kop) filter (where pay_source = 'cash_register')::bigint as paid_suppliers_cash_kop
    from public.purchases where deleted_at is null group by shop_id, day
),
exp as (
  select shop_id, day, sum(amount_kop)::bigint as expenses_kop,
         sum(amount_kop) filter (where from_register)::bigint as expenses_cash_kop
    from public.expenses where deleted_at is null group by shop_id, day
),
wo as (
  select shop_id, day, sum(sum_kop)::bigint as writeoffs_kop
    from public.writeoffs where deleted_at is null group by shop_id, day
),
debt as (
  select shop_id, day,
         sum(amount_kop) filter (where kind = 'credit')::bigint    as sold_on_credit_kop,
         sum(amount_kop) filter (where kind = 'repayment')::bigint as debt_repaid_kop
    from public.customer_debts where deleted_at is null group by shop_id, day
)
select d.shop_id, d.day,
       coalesce(pur.purchase_count, 0)          as purchase_count,
       coalesce(pur.buy_kop, 0)                 as buy_kop,
       coalesce(pur.sell_kop, 0)                as sell_kop,
       coalesce(pur.sell_kop, 0) - coalesce(pur.buy_kop, 0) as profit_kop,
       coalesce(pur.paid_suppliers_cash_kop, 0) as paid_suppliers_cash_kop,
       coalesce(exp.expenses_kop, 0)            as expenses_kop,
       coalesce(exp.expenses_cash_kop, 0)       as expenses_cash_kop,
       coalesce(wo.writeoffs_kop, 0)            as writeoffs_kop,
       coalesce(debt.sold_on_credit_kop, 0)     as sold_on_credit_kop,
       coalesce(debt.debt_repaid_kop, 0)        as debt_repaid_kop,
       c.cash_evening_kop,
       c.terminal_kop,
       coalesce(c.cash_morning_kop, prev.cash_evening_kop, 0) as cash_morning_kop,
       coalesce(c.from_card_kop, 0)             as from_card_kop,
       coalesce(c.taken_by_owner_kop, 0)        as taken_by_owner_kop,
       (c.cash_evening_kop is not null and c.terminal_kop is not null) as cash_entered
  from days d
  left join pur  using (shop_id, day)
  left join exp  using (shop_id, day)
  left join wo   using (shop_id, day)
  left join debt using (shop_id, day)
  left join public.cash_days c on c.shop_id = d.shop_id and c.day = d.day
  left join lateral (
    select cd.cash_evening_kop from public.cash_days cd
     where cd.shop_id = d.shop_id and cd.day < d.day and cd.cash_evening_kop is not null
     order by cd.day desc limit 1
  ) prev on true;

-- ═══════════════════════════ Корзина ═══════════════════════════
-- Удалённое (deleted_at) хранится 30 дней, потом стирается.
create or replace function public.purge_trash()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.purchases      where deleted_at < now() - interval '30 days';
  delete from public.expenses       where deleted_at < now() - interval '30 days';
  delete from public.writeoffs      where deleted_at < now() - interval '30 days';
  delete from public.customer_debts where deleted_at < now() - interval '30 days';
  delete from public.recurring_expenses where deleted_at < now() - interval '30 days';
end $$;
revoke all on function public.purge_trash() from public;

-- Запуск очистки каждую ночь (если в проекте доступен pg_cron).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('kassa-purge-trash', '15 3 * * *', 'select public.purge_trash()');
exception when others then
  raise notice 'pg_cron недоступен — корзину можно чистить вручную: select public.purge_trash();';
end $$;

-- ═══════════════════════════ Выдача прав ролям Supabase ═══════════════════════════
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
grant select on public.day_totals to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_shop(text, text) to authenticated;
grant execute on function public.add_purchase_seller(uuid, uuid, date, uuid, uuid, numeric, public.unit_kind,
  public.buy_input, bigint, bigint, bigint, public.pay_source, text) to authenticated;
grant execute on function public.seller_purchases(uuid, date) to authenticated;
grant execute on function public.seller_writeoffs(uuid, date) to authenticated;
grant execute on function public.member_role_of(uuid), public.is_member(uuid), public.is_owner(uuid),
  public.can_see_costs(uuid), public.can_enter(uuid) to authenticated;
