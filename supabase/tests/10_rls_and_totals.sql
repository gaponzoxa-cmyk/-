-- Проверка прав и итогов. Запуск: scripts/test-db.sh
\set ON_ERROR_STOP on
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'owner@test'),
  ('00000000-0000-0000-0000-00000000000b', 'seller@test'),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@test');

-- владелец создаёт магазин
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.create_shop('Тест', 'Владелец') as shop \gset
insert into public.shop_members (shop_id, user_id, role)
  values (:'shop', '00000000-0000-0000-0000-00000000000b', 'seller');

insert into public.products (shop_id, name) values (:'shop', 'Банан') returning id as banana \gset
insert into public.products (shop_id, name) values (:'shop', 'Укроп') returning id as dill \gset

-- ввод ценой: 20,2 × 71,8 = 1450,36 ; приход 20,2 × 90 = 1818,00
insert into public.purchases (shop_id, day, product_id, qty, unit, buy_price_kop, sell_price_kop)
  values (:'shop', '2026-11-03', :'banana', 20.2, 'kg', 7180, 9000);
-- ввод суммой: отдал 265 ₴ за 1,06 кг → 250 ₴/кг; заплачено своими (не из кассы)
insert into public.purchases (shop_id, day, product_id, qty, unit, buy_input, buy_sum_kop, sell_price_kop, pay_source)
  values (:'shop', '2026-11-03', :'dill', 1.06, 'kg', 'sum', 26500, 35000, 'own');

select buy_price_kop, buy_sum_kop, sell_sum_kop from public.purchases order by created_at;

insert into public.cash_days (shop_id, day, cash_evening_kop, terminal_kop, cash_morning_kop)
  values (:'shop', '2026-11-02', 200000, 0, 0);
insert into public.cash_days (shop_id, day, cash_evening_kop, terminal_kop, from_card_kop)
  values (:'shop', '2026-11-03', 100000, 50000, 0);
insert into public.expenses (shop_id, day, category, amount_kop) values (:'shop', '2026-11-03', 'Пакеты', 15000);
insert into public.writeoffs (shop_id, day, product_id, qty, reason) values (:'shop', '2026-11-03', :'banana', 1.5, 'почернел');

select day, purchase_count, buy_kop, sell_kop, profit_kop, paid_suppliers_cash_kop, expenses_cash_kop,
       writeoffs_kop, cash_morning_kop, cash_evening_kop, terminal_kop, cash_entered
  from public.day_totals where shop_id = :'shop' order by day;

do $$ declare t record; begin
  select * into t from public.day_totals where day = '2026-11-03';
  assert t.buy_kop = 145036 + 26500, 'закупка';
  assert t.sell_kop = 181800 + 37100, 'приход';
  assert t.paid_suppliers_cash_kop = 145036, 'из кассы поставщикам';
  assert t.cash_morning_kop = 200000, 'утро = вчерашний вечер';
  assert t.writeoffs_kop = 10770, 'списание 1,5 × 71,8';
end $$;

-- продавец
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ declare n int; begin
  select count(*) into n from public.purchases;          assert n = 0, 'продавец не должен видеть purchases';
  select count(*) into n from public.writeoffs;          assert n = 0, 'продавец не должен видеть writeoffs';
  select count(*) into n from public.cash_days;          assert n = 2, 'продавец видит кассу';
  select count(*) into n from public.products;           assert n = 2, 'продавец видит товары';
end $$;
select product_name, qty, sell_price_kop, paid_cash_kop from public.seller_purchases(:'shop', '2026-11-03');
-- продавец вносит закупку через функцию
select public.add_purchase_seller('11111111-1111-1111-1111-111111111111', :'shop', '2026-11-04', :'banana', null,
  10, 'kg', 'price', 7000, null, 9000, 'cash_register', null);
-- повтор (офлайн-очередь) не создаёт дубль
select public.add_purchase_seller('11111111-1111-1111-1111-111111111111', :'shop', '2026-11-04', :'banana', null,
  10, 'kg', 'price', 7000, null, 9000, 'cash_register', null);
-- прямая вставка запрещена
do $$ begin
  begin
    insert into public.purchases (shop_id, day, product_id, qty, unit, buy_price_kop, sell_price_kop)
      select shop_id, '2026-11-04', id, 1, 'kg', 1, 1 from public.products limit 1;
    raise exception 'продавец не должен вставлять в purchases напрямую';
  exception when insufficient_privilege then null;
  end;
end $$;

-- посторонний
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
do $$ declare n int; begin
  select count(*) into n from public.shops;        assert n = 0, 'чужой магазин виден';
  select count(*) into n from public.cash_days;    assert n = 0, 'чужая касса видна';
  select count(*) into n from public.seller_purchases((select '00000000-0000-0000-0000-000000000000'::uuid), '2026-11-03');
end $$;

-- владелец: дубль не появился, журнал пишется
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ declare n int; begin
  select count(*) into n from public.purchases where day = '2026-11-04'; assert n = 1, 'дубль из офлайн-очереди';
  select count(*) into n from public.audit_log;                           assert n > 0, 'журнал пуст';
end $$;
reset role;
select 'OK: все проверки базы пройдены' as result;
