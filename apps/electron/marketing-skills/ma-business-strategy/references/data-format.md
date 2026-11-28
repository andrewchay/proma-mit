# 数据格式参考

## 订单数据格式（orders.json）

```json
[
  {
    "order_id": "123456789",
    "product_name": "金枕榴莲肉",
    "actual_amount": 88.0,
    "distance_km": 2.5,
    "hour": 20,
    "weekday": 5,
    "is_weekend": false,
    "city": "杭州",
    "store": "门店A"
  }
]
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| order_id | string | 订单 ID |
| product_name | string | 产品名称 |
| actual_amount | float | 实付金额（元） |
| distance_km | float | 配送距离（公里） |
| hour | int | 下单小时（0-23） |
| weekday | int | 星期几（0=周日，6=周六） |
| is_weekend | bool | 是否周末 |
| city | string | 城市 |
| store | string | 门店 |

## 产品数据格式（products.json）

```json
[
  {
    "name": "金枕榴莲肉",
    "price": 88.0,
    "sales": 934,
    "revenue": 82192.0,
    "fruit_cost": 22.0,
    "box_cost": 3.0,
    "人工": 2.0,
    "total_cost": 45.5,
    "gross_profit": 42.5,
    "margin_rate": 0.483
  }
]
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 产品名称 |
| price | float | 售价（元） |
| sales | int | 销量 |
| revenue | float | 营收（元） |
| fruit_cost | float | 水果成本（元） |
| box_cost | float | 包装成本（元） |
| 人工 | float | 人工成本（元） |
| total_cost | float | 总成本（元） |
| gross_profit | float | 毛利润（元） |
| margin_rate | float | 毛利率（0-1） |

## 数据预处理脚本示例

### Excel 转 JSON

```python
import pandas as pd
import json

# 读取订单数据
orders_df = pd.read_excel('orders.xlsx')
orders = orders_df.to_dict('records')

# 保存为 JSON
with open('orders.json', 'w', encoding='utf-8') as f:
    json.dump(orders, f, ensure_ascii=False, indent=2)

# 读取产品数据
products_df = pd.read_excel('products.xlsx')
products = products_df.to_dict('records')

# 计算衍生指标
for p in products:
    p['total_cost'] = p.get('fruit_cost', 0) + p.get('box_cost', 0) + p.get('人工', 0)
    p['gross_profit'] = p['price'] - p['total_cost']
    p['margin_rate'] = p['gross_profit'] / p['price'] if p['price'] > 0 else 0
    p['revenue'] = p['price'] * p['sales']

with open('products.json', 'w', encoding='utf-8') as f:
    json.dump(products, f, ensure_ascii=False, indent=2)
```

### 数据清洗检查清单

- [ ] 订单数据和产品数据的 SKU 名称是否一致？
- [ ] 缺失值如何处理？（删除/填充/标注）
- [ ] 异常值如何识别？（如负毛利、超高人工）
- [ ] 数据口径是否统一？（订单表销量 vs 产品表销量）
- [ ] 时间范围是否一致？

## 输出格式示例

### 健康度评分卡（health-check.json）

```json
{
  "overall_score": 72.5,
  "grade": "B+",
  "dimensions": {
    "revenue_quality": {
      "score": 85,
      "key_metric": "客单价 ¥85.73",
      "risk": "营收集中度中等",
      "details": {
        "avg_order_value": 85.73,
        "total_revenue": 3216000,
        "total_orders": 37511,
        "top5_concentration": 45.2
      }
    }
  },
  "top_risks": [
    {
      "risk": "食安客诉",
      "severity": "high",
      "mitigation": "标准化背书 + 食品安全险"
    }
  ],
  "recommendations": [
    "优化 SKU 结构，淘汰低毛利产品"
  ]
}
```

### 四象限分析（quadrant-analysis.json）

```json
{
  "median_sales": 539.5,
  "median_margin": 45.1,
  "total_products": 27,
  "quadrants": {
    "stars": [
      {
        "name": "金枕榴莲肉",
        "price": 88,
        "sales": 934,
        "revenue": 82192,
        "margin_rate": 48.3,
        "revenue_contribution": 25.5,
        "profit_contribution": 29.2,
        "action": "保持放大"
      }
    ]
  },
  "price_bands": [
    {
      "band": "¥30-50",
      "product_count": 10,
      "total_sales": 6911,
      "total_revenue": 284297,
      "avg_margin": 47.6
    }
  ],
  "recommendations": [
    {
      "sku": "牛三网纹蜜瓜",
      "action": "提价或降成本",
      "reason": "高销量但毛利率仅 19.8%",
      "priority": "high"
    }
  ]
}
```
