#!/usr/bin/env python3
"""
业务健康度诊断脚本
Business Health Check Script

基于订单数据和产品数据，计算业务健康度评分卡
"""

import json
import sys
import argparse
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from pathlib import Path


@dataclass
class HealthDimension:
    """健康度维度"""
    name: str
    score: int  # 0-100
    key_metric: str
    risk: str
    details: Dict[str, Any]


class BusinessHealthChecker:
    """业务健康度诊断器"""

    def __init__(self, orders_data: List[Dict], products_data: List[Dict]):
        self.orders = orders_data
        self.products = products_data
        self.dimensions: List[HealthDimension] = []

    def calculate_overall_health(self) -> Dict[str, Any]:
        """计算整体健康度"""
        # 计算各维度
        revenue_quality = self._check_revenue_quality()
        profit_structure = self._check_profit_structure()
        operational_efficiency = self._check_operational_efficiency()
        growth_potential = self._check_growth_potential()

        self.dimensions = [
            revenue_quality,
            profit_structure,
            operational_efficiency,
            growth_potential
        ]

        # 计算总分
        overall_score = sum(d.score for d in self.dimensions) / len(self.dimensions)

        # 识别顶级风险
        top_risks = self._identify_top_risks()

        return {
            "overall_score": round(overall_score, 1),
            "grade": self._score_to_grade(overall_score),
            "dimensions": {
                "revenue_quality": {
                    "score": revenue_quality.score,
                    "key_metric": revenue_quality.key_metric,
                    "risk": revenue_quality.risk,
                    "details": revenue_quality.details
                },
                "profit_structure": {
                    "score": profit_structure.score,
                    "key_metric": profit_structure.key_metric,
                    "risk": profit_structure.risk,
                    "details": profit_structure.details
                },
                "operational_efficiency": {
                    "score": operational_efficiency.score,
                    "key_metric": operational_efficiency.key_metric,
                    "risk": operational_efficiency.risk,
                    "details": operational_efficiency.details
                },
                "growth_potential": {
                    "score": growth_potential.score,
                    "key_metric": growth_potential.key_metric,
                    "risk": growth_potential.risk,
                    "details": growth_potential.details
                }
            },
            "top_risks": top_risks,
            "recommendations": self._generate_recommendations()
        }

    def _check_revenue_quality(self) -> HealthDimension:
        """检查营收质量"""
        if not self.orders:
            return HealthDimension("营收质量", 0, "无订单数据", "数据缺失", {})

        # 计算客单价
        total_revenue = sum(o.get('actual_amount', 0) for o in self.orders)
        total_orders = len(self.orders)
        avg_order_value = total_revenue / total_orders if total_orders > 0 else 0

        # 计算营收集中度（Top 5 SKU 占比）
        sku_revenue: Dict[str, float] = {}
        for o in self.orders:
            sku = o.get('product_name', 'unknown')
            sku_revenue[sku] = sku_revenue.get(sku, 0) + o.get('actual_amount', 0)

        sorted_sku = sorted(sku_revenue.items(), key=lambda x: x[1], reverse=True)
        top5_revenue = sum(r for _, r in sorted_sku[:5])
        concentration = top5_revenue / total_revenue if total_revenue > 0 else 0

        # 评分逻辑
        score = 70  # 基础分
        if avg_order_value > 80:
            score += 15  # 高客单价加分
        elif avg_order_value > 50:
            score += 10
        elif avg_order_value < 30:
            score -= 10

        if concentration > 0.7:
            score -= 10  # 过度集中
            risk = "营收过度依赖少数 SKU"
        elif concentration < 0.3:
            score += 5  # 分散度好
            risk = "营收集中度健康"
        else:
            risk = "营收集中度中等"

        return HealthDimension(
            "营收质量",
            min(100, max(0, score)),
            f"客单价 ¥{avg_order_value:.2f}",
            risk,
            {
                "avg_order_value": avg_order_value,
                "total_revenue": total_revenue,
                "total_orders": total_orders,
                "top5_concentration": round(concentration * 100, 1)
            }
        )

    def _check_profit_structure(self) -> HealthDimension:
        """检查利润结构"""
        if not self.products:
            return HealthDimension("利润结构", 0, "无产品数据", "数据缺失", {})

        # 计算整体毛利率
        total_revenue = sum(p.get('revenue', 0) for p in self.products)
        total_cost = sum(p.get('total_cost', 0) for p in self.products)
        overall_margin = (total_revenue - total_cost) / total_revenue if total_revenue > 0 else 0

        # 识别低毛利 SKU
        low_margin_skus = [
            p for p in self.products
            if p.get('margin_rate', 0) < 0.25 and p.get('sales', 0) > 100
        ]

        # 识别高毛利 SKU
        high_margin_skus = [
            p for p in self.products
            if p.get('margin_rate', 0) > 0.50
        ]

        # 评分逻辑
        score = 60  # 基础分
        if overall_margin > 0.45:
            score += 20
        elif overall_margin > 0.35:
            score += 10
        elif overall_margin < 0.25:
            score -= 15

        if len(low_margin_skus) > 3:
            score -= 10
            risk = f"{len(low_margin_skus)} 个低毛利 SKU 拖累利润"
        else:
            risk = "利润结构健康"

        return HealthDimension(
            "利润结构",
            min(100, max(0, score)),
            f"毛利率 {overall_margin * 100:.1f}%",
            risk,
            {
                "overall_margin": round(overall_margin * 100, 1),
                "low_margin_sku_count": len(low_margin_skus),
                "high_margin_sku_count": len(high_margin_skus),
                "low_margin_skus": [p.get('name', 'unknown') for p in low_margin_skus[:5]]
            }
        )

    def _check_operational_efficiency(self) -> HealthDimension:
        """检查运营效率"""
        if not self.orders:
            return HealthDimension("运营效率", 0, "无订单数据", "数据缺失", {})

        # 时段分布
        hour_distribution: Dict[int, int] = {}
        for o in self.orders:
            hour = o.get('hour', 0)
            hour_distribution[hour] = hour_distribution.get(hour, 0) + 1

        # 晚高峰占比（17-22 点）
        evening_orders = sum(hour_distribution.get(h, 0) for h in range(17, 23))
        evening_ratio = evening_orders / len(self.orders)

        # 距离分布
        distance_distribution: Dict[str, int] = {"≤3km": 0, "3-5km": 0, ">5km": 0}
        for o in self.orders:
            dist = o.get('distance_km', 0)
            if dist <= 3:
                distance_distribution["≤3km"] += 1
            elif dist <= 5:
                distance_distribution["3-5km"] += 1
            else:
                distance_distribution[">5km"] += 1

        # 评分逻辑
        score = 65  # 基础分
        if 0.3 < evening_ratio < 0.5:
            score += 10  # 健康的时段分布
        elif evening_ratio > 0.6:
            score -= 5  # 过度依赖晚高峰

        core_ratio = distance_distribution["≤3km"] / len(self.orders)
        if core_ratio > 0.7:
            score += 10  # 核心半径集中

        return HealthDimension(
            "运营效率",
            min(100, max(0, score)),
            f"晚高峰占比 {evening_ratio * 100:.1f}%",
            "时段分布健康" if 0.25 < evening_ratio < 0.55 else "时段分布不均",
            {
                "evening_ratio": round(evening_ratio * 100, 1),
                "distance_distribution": distance_distribution,
                "core_radius_ratio": round(core_ratio * 100, 1)
            }
        )

    def _check_growth_potential(self) -> HealthDimension:
        """检查增长潜力"""
        if not self.orders or not self.products:
            return HealthDimension("增长潜力", 0, "数据不足", "数据缺失", {})

        # 夜间订单占比（00-06 点）
        night_orders = sum(1 for o in self.orders if 0 <= o.get('hour', 0) < 6)
        night_ratio = night_orders / len(self.orders)

        # 高毛利 SKU 占比
        high_margin_count = sum(1 for p in self.products if p.get('margin_rate', 0) > 0.45)
        high_margin_ratio = high_margin_count / len(self.products)

        # 评分逻辑
        score = 60  # 基础分
        if night_ratio > 0.15:
            score += 15  # 夜间场景优势
        elif night_ratio > 0.08:
            score += 8

        if high_margin_ratio > 0.5:
            score += 10  # 高毛利产品占比高

        return HealthDimension(
            "增长潜力",
            min(100, max(0, score)),
            f"夜间占比 {night_ratio * 100:.1f}%",
            "夜间场景可放大" if night_ratio > 0.08 else "新场景待开发",
            {
                "night_ratio": round(night_ratio * 100, 1),
                "high_margin_sku_ratio": round(high_margin_ratio * 100, 1),
                "growth_opportunities": self._identify_growth_opportunities()
            }
        )

    def _identify_growth_opportunities(self) -> List[str]:
        """识别增长机会"""
        opportunities = []

        # 基于时段
        night_orders = sum(1 for o in self.orders if 0 <= o.get('hour', 0) < 6)
        if night_orders / len(self.orders) > 0.08:
            opportunities.append("夜间场景放大")

        # 基于产品
        high_margin_low_sales = [
            p for p in self.products
            if p.get('margin_rate', 0) > 0.50 and p.get('sales', 0) < 500
        ]
        if high_margin_low_sales:
            opportunities.append("高毛利低销量 SKU 曝光提升")

        return opportunities

    def _identify_top_risks(self) -> List[Dict[str, str]]:
        """识别顶级风险"""
        risks = []

        # 食安风险（高客单价业务）
        avg_order = sum(o.get('actual_amount', 0) for o in self.orders) / len(self.orders) if self.orders else 0
        if avg_order > 60:
            risks.append({
                "risk": "食安客诉",
                "severity": "high",
                "mitigation": "标准化背书 + 食品安全险"
            })

        # 低毛利 SKU 风险
        low_margin_count = sum(1 for p in self.products if p.get('margin_rate', 0) < 0.25)
        if low_margin_count > 2:
            risks.append({
                "risk": "低毛利 SKU 拖累",
                "severity": "medium",
                "mitigation": "SKU 优化或提价"
            })

        # 数据口径风险
        risks.append({
            "risk": "数据口径不匹配",
            "severity": "medium",
            "mitigation": "统一数据口径，纳入 OKR"
        })

        return risks

    def _generate_recommendations(self) -> List[str]:
        """生成建议"""
        recommendations = []

        # 基于诊断结果生成建议
        profit_dim = next((d for d in self.dimensions if d.name == "利润结构"), None)
        if profit_dim and profit_dim.score < 70:
            recommendations.append("优化 SKU 结构，淘汰低毛利产品")

        growth_dim = next((d for d in self.dimensions if d.name == "增长潜力"), None)
        if growth_dim and "夜间" in growth_dim.risk:
            recommendations.append("放大夜间场景，推出深夜专属套餐")

        return recommendations

    @staticmethod
    def _score_to_grade(score: float) -> str:
        """分数转等级"""
        if score >= 90:
            return "A+"
        elif score >= 80:
            return "A"
        elif score >= 70:
            return "B+"
        elif score >= 60:
            return "B"
        elif score >= 50:
            return "C"
        else:
            return "D"


def load_data(file_path: str) -> List[Dict]:
    """加载数据文件"""
    path = Path(file_path)
    if not path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    # 根据扩展名选择加载方式
    if path.suffix == '.json':
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    elif path.suffix in ['.csv', '.xlsx', '.xls']:
        # 这里简化处理，实际应该用 pandas
        print(f"Error: Please convert {path.suffix} to JSON first", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"Error: Unsupported file format: {path.suffix}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='Business Health Check')
    parser.add_argument('--orders', required=True, help='Orders data file (JSON)')
    parser.add_argument('--products', required=True, help='Products data file (JSON)')
    parser.add_argument('--output', required=True, help='Output file path')

    args = parser.parse_args()

    # 加载数据
    orders_data = load_data(args.orders)
    products_data = load_data(args.products)

    # 运行诊断
    checker = BusinessHealthChecker(orders_data, products_data)
    result = checker.calculate_overall_health()

    # 保存结果
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Health check completed. Results saved to: {output_path}")
    print(f"Overall Score: {result['overall_score']} ({result['grade']})")


if __name__ == '__main__':
    main()
