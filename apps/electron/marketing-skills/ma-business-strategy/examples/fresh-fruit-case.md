# 鲜果切业务诊断示例

## 输入数据示例

### 订单数据（orders.json）

```json
[
  {"order_id": "001", "product_name": "金枕榴莲肉", "actual_amount": 88.0, "distance_km": 2.5, "hour": 20, "weekday": 5, "is_weekend": false, "city": "杭州", "store": "门店A"},
  {"order_id": "002", "product_name": "海南水仙芒", "actual_amount": 30.0, "distance_km": 1.8, "hour": 21, "weekday": 5, "is_weekend": false, "city": "杭州", "store": "门店A"},
  {"order_id": "003", "product_name": "牛三网纹蜜瓜", "actual_amount": 30.0, "distance_km": 3.2, "hour": 22, "weekday": 6, "is_weekend": true, "city": "上海", "store": "门店B"}
]
```

### 产品数据（products.json）

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
  },
  {
    "name": "牛三网纹蜜瓜",
    "price": 30.0,
    "sales": 1788,
    "revenue": 53640.0,
    "fruit_cost": 18.0,
    "box_cost": 2.0,
    "人工": 2.0,
    "total_cost": 24.1,
    "gross_profit": 5.9,
    "margin_rate": 0.198
  }
]
```

## 运行分析

```bash
# 1. 业务健康度诊断
python3 scripts/business_health_check.py \
  --orders examples/orders.json \
  --products examples/products.json \
  --output diagnosis/health-check.json

# 2. 产品四象限分析
python3 scripts/product_quadrant.py \
  --products examples/products.json \
  --output diagnosis/quadrant-analysis.json
```

## 预期输出

### 健康度评分卡

```json
{
  "overall_score": 72.5,
  "grade": "B+",
  "dimensions": {
    "revenue_quality": {
      "score": 85,
      "key_metric": "客单价 ¥85.73",
      "risk": "营收集中度中等"
    },
    "profit_structure": {
      "score": 68,
      "key_metric": "毛利率 42.2%",
      "risk": "部分 SKU 毛利过低"
    }
  },
  "top_risks": [
    {"risk": "食安客诉", "severity": "high", "mitigation": "标准化背书 + 保险"}
  ]
}
```

### 四象限分析

```json
{
  "median_sales": 539.5,
  "median_margin": 45.1,
  "quadrants": {
    "stars": [
      {"name": "金枕榴莲肉", "sales": 934, "margin_rate": 48.3, "action": "保持放大"}
    ],
    "cash_cows": [
      {"name": "牛三网纹蜜瓜", "sales": 1788, "margin_rate": 19.8, "action": "提价或降成本"}
    ]
  }
}
```

## 关键发现

1. **客单价 ¥85.73** 远超行业平均，但 SKU 臃肿（27 个）
2. **芒果系列**毛利率 55%+，是利润引擎
3. **牛三网纹蜜瓜**高销量但毛利仅 19.8%，需优化
4. **夜间订单**占比 11.7%，侧翼优势可放大
5. **数据口径**不匹配（产品表销量仅为订单表 49.7%）

## 战略建议

1. **SKU 优化**：27 → 15-18 个，淘汰低毛利长尾
2. **价格带调整**：巩固 ¥30-50 黄金带，扩充 ¥80-100 高价值带
3. **夜间场景**：推出深夜专属套餐，目标占比 20%+
4. **标准化背书**：白手套透明化 + 防拆贴 + 时间标签
5. **数据基建**：1 个月内统一数据口径
