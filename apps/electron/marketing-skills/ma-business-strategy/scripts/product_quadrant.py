#!/usr/bin/env python3
"""
产品四象限分析脚本
Product Quadrant Analysis Script

基于销量和毛利率将 SKU 分为四象限
"""

import json
import sys
import argparse
from typing import Dict, List, Any
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Product:
    """产品数据类"""
    name: str
    price: float
    sales: int
    revenue: float
    total_cost: float
    gross_profit: float
    margin_rate: float
    revenue_contribution: float
    profit_contribution: float


class ProductQuadrantAnalyzer:
    """产品四象限分析器"""

    def __init__(self, products_data: List[Dict]):
        self.products = self._parse_products(products_data)
        self.median_sales = 0
        self.median_margin = 0

    def _parse_products(self, data: List[Dict]) -> List[Product]:
        """解析产品数据"""
        products = []
        total_revenue = sum(p.get('revenue', 0) for p in data)
        total_profit = sum(p.get('gross_profit', 0) for p in data)

        for p in data:
            revenue = p.get('revenue', 0)
            gross_profit = p.get('gross_profit', 0)
            margin_rate = p.get('margin_rate', 0)

            products.append(Product(
                name=p.get('name', 'unknown'),
                price=p.get('price', 0),
                sales=p.get('sales', 0),
                revenue=revenue,
                total_cost=p.get('total_cost', 0),
                gross_profit=gross_profit,
                margin_rate=margin_rate,
                revenue_contribution=revenue / total_revenue if total_revenue > 0 else 0,
                profit_contribution=gross_profit / total_profit if total_profit > 0 else 0
            ))

        return products

    def calculate_medians(self) -> None:
        """计算中位数"""
        sales_list = sorted([p.sales for p in self.products])
        margin_list = sorted([p.margin_rate for p in self.products])

        n = len(sales_list)
        self.median_sales = sales_list[n // 2] if n % 2 == 1 else (sales_list[n // 2 - 1] + sales_list[n // 2]) / 2

        m = len(margin_list)
        self.median_margin = margin_list[m // 2] if m % 2 == 1 else (margin_list[m // 2 - 1] + margin_list[m // 2]) / 2

    def classify_quadrants(self) -> Dict[str, List[Dict]]:
        """四象限分类"""
        self.calculate_medians()

        quadrants = {
            "stars": [],      # 高销量 × 高毛利
            "cash_cows": [],  # 高销量 × 低毛利
            "question_marks": [],  # 低销量 × 高毛利
            "dogs": []        # 低销量 × 低毛利
        }

        for p in self.products:
            product_info = {
                "name": p.name,
                "price": p.price,
                "sales": p.sales,
                "revenue": round(p.revenue, 2),
                "margin_rate": round(p.margin_rate * 100, 1),
                "revenue_contribution": round(p.revenue_contribution * 100, 1),
                "profit_contribution": round(p.profit_contribution * 100, 1)
            }

            if p.sales >= self.median_sales and p.margin_rate >= self.median_margin:
                product_info["action"] = "保持放大"
                quadrants["stars"].append(product_info)
            elif p.sales >= self.median_sales and p.margin_rate < self.median_margin:
                product_info["action"] = "提毛利或转引流"
                quadrants["cash_cows"].append(product_info)
            elif p.sales < self.median_sales and p.margin_rate >= self.median_margin:
                product_info["action"] = "加大曝光"
                quadrants["question_marks"].append(product_info)
            else:
                product_info["action"] = "优化或淘汰"
                quadrants["dogs"].append(product_info)

        # 按销量排序
        for key in quadrants:
            quadrants[key].sort(key=lambda x: x["sales"], reverse=True)

        return quadrants

    def analyze_price_bands(self) -> List[Dict]:
        """价格带分析"""
        bands = [
            {"label": "<¥30", "min": 0, "max": 30},
            {"label": "¥30-50", "min": 30, "max": 50},
            {"label": "¥50-80", "min": 50, "max": 80},
            {"label": "¥80-100", "min": 80, "max": 100},
            {"label": ">¥100", "min": 100, "max": float('inf')}
        ]

        results = []
        for band in bands:
            band_products = [p for p in self.products if band["min"] <= p.price < band["max"]]
            if not band_products:
                continue

            total_sales = sum(p.sales for p in band_products)
            total_revenue = sum(p.revenue for p in band_products)
            total_profit = sum(p.gross_profit for p in band_products)
            avg_margin = total_profit / total_revenue if total_revenue > 0 else 0

            results.append({
                "band": band["label"],
                "product_count": len(band_products),
                "total_sales": total_sales,
                "total_revenue": round(total_revenue, 2),
                "avg_margin": round(avg_margin * 100, 1),
                "products": [p.name for p in band_products]
            })

        return results

    def generate_recommendations(self, quadrants: Dict) -> List[Dict]:
        """生成 SKU 调整建议"""
        recommendations = []

        # 问题产品建议
        for p in quadrants["dogs"]:
            if p["margin_rate"] < 25:
                recommendations.append({
                    "sku": p["name"],
                    "action": "优化或淘汰",
                    "reason": f"毛利率仅 {p['margin_rate']}%，低于安全线",
                    "priority": "high"
                })

        # 引流产品建议
        for p in quadrants["cash_cows"]:
            if p["margin_rate"] < 30:
                recommendations.append({
                    "sku": p["name"],
                    "action": "提价或降成本",
                    "reason": f"高销量但毛利率仅 {p['margin_rate']}%",
                    "priority": "high"
                })

        # 潜力产品建议
        for p in quadrants["question_marks"]:
            if p["margin_rate"] > 50:
                recommendations.append({
                    "sku": p["name"],
                    "action": "加大曝光",
                    "reason": f"高毛利 ({p['margin_rate']}%) 但销量低",
                    "priority": "medium"
                })

        return recommendations

    def run_analysis(self) -> Dict[str, Any]:
        """运行完整分析"""
        quadrants = self.classify_quadrants()
        price_bands = self.analyze_price_bands()
        recommendations = self.generate_recommendations(quadrants)

        return {
            "median_sales": self.median_sales,
            "median_margin": round(self.median_margin * 100, 1),
            "total_products": len(self.products),
            "quadrants": quadrants,
            "price_bands": price_bands,
            "recommendations": recommendations
        }


def load_products(file_path: str) -> List[Dict]:
    """加载产品数据"""
    path = Path(file_path)
    if not path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description='Product Quadrant Analysis')
    parser.add_argument('--products', required=True, help='Products data file (JSON)')
    parser.add_argument('--output', required=True, help='Output file path')

    args = parser.parse_args()

    # 加载数据
    products_data = load_products(args.products)

    # 运行分析
    analyzer = ProductQuadrantAnalyzer(products_data)
    result = analyzer.run_analysis()

    # 保存结果
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Quadrant analysis completed. Results saved to: {output_path}")
    print(f"Total products: {result['total_products']}")
    print(f"Median sales: {result['median_sales']}")
    print(f"Median margin: {result['median_margin']}%")


if __name__ == '__main__':
    main()
