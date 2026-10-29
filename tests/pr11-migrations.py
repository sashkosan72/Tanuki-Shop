"""Offline-only test of existing additive migration scripts."""
import sqlite3
from pathlib import Path
root=Path(__file__).resolve().parent.parent
db=sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript((root/"tests/store-schema.sql").read_text())
for n in range(49):
    db.execute("INSERT INTO orders(order_number,customer_name,customer_phone,customer_city,customer_address,total_amount) VALUES(?,?,?,?,?,?)",(f"QA-{n}","Test","0000000000","Test","Test",100+n))
db.commit()
before=list(db.execute("SELECT id,order_number,total_amount FROM orders ORDER BY id"))
for name in ("20261028_promotions.sql","20261028_shipping_methods.sql"):
    db.executescript((root/"migrations"/name).read_text())
after=list(db.execute("SELECT id,order_number,total_amount FROM orders ORDER BY id"))
assert before==after
assert db.execute("SELECT count(*) FROM orders WHERE shipping_method='unspecified'").fetchone()[0]==49
assert not db.execute("PRAGMA foreign_key_check").fetchall()
assert {x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE name IN ('promotions','order_promotions')")}=={"promotions","order_promotions"}
print("PASS: additive migration fixture")
