// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import {
  deepClone,
  Expression,
  Prototypes,
  Scale,
  setField,
  Solver,
  Specification,
  uniqueID
} from "../../../core";
import { ValueType } from "../../../core/expression/classes";
import { Actions } from "../../actions";
import { AppStore } from "../app_store";
import { ChartElementSelection } from "../selection";
import { ActionHandlerRegistry } from "./registry";

export default function(REG: ActionHandlerRegistry<AppStore, Actions.Action>) {
  REG.add(Actions.MapDataToChartElementAttribute, function(action) {
    const attr = Prototypes.ObjectClasses.Create(
      null,
      action.chartElement,
      null
    ).attributes[action.attribute];
    const table = this.getTable(action.table);
    const inferred = this.scaleInference(
      { chart: { table: action.table } },
      action.expression,
      action.valueType,
      action.valueMetadata.kind,
      action.attributeType,
      action.hints
    );
    if (inferred != null) {
      action.chartElement.mappings[action.attribute] = {
        type: "scale",
        table: action.table,
        expression: action.expression,
        valueType: action.valueType,
        scale: inferred
      } as Specification.ScaleMapping;
    } else {
      if (
        (action.valueType == Specification.DataType.String ||
          action.valueType == Specification.DataType.Number) &&
        action.attributeType == Specification.AttributeType.Text
      ) {
        // If the valueType is a number, use a format
        const format =
          action.valueType == Specification.DataType.Number ? ".1f" : undefined;
        action.chartElement.mappings[action.attribute] = {
          type: "text",
          table: action.table,
          textExpression: new Expression.TextExpression([
            { expression: Expression.parse(action.expression), format }
          ]).toString()
        } as Specification.TextMapping;
      }
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.AddChartElement, function(action) {
    this.saveHistory();

    let glyph = this.currentGlyph;
    if (!glyph || this.chart.glyphs.indexOf(glyph) < 0) {
      glyph = this.chart.glyphs[0];
    }

    const newChartElement = this.chartManager.createObject(
      action.classID,
      glyph
    ) as Specification.PlotSegment;
    for (const key in action.properties) {
      newChartElement.properties[key] = action.properties[key];
    }
    // console.log(newPlotSegment);
    if (Prototypes.isType(action.classID, "plot-segment")) {
      newChartElement.filter = null;
      newChartElement.order = null;
    }

    this.chartManager.addChartElement(newChartElement);

    const idx = this.chart.elements.indexOf(newChartElement);
    const elementClass = this.chartManager.getChartElementClass(
      this.chartState.elements[idx]
    );

    for (const key in action.mappings) {
      if (action.mappings.hasOwnProperty(key)) {
        const [value, mapping] = action.mappings[key];
        if (mapping != null) {
          if (mapping.type == "_element") {
            this.chartManager.chart.constraints.push({
              type: "snap",
              attributes: {
                element: newChartElement._id,
                attribute: key,
                targetElement: (mapping as any).element,
                targetAttribute: (mapping as any).attribute,
                gap: 0
              }
            });
          } else {
            newChartElement.mappings[key] = mapping;
          }
        }
        if (value != null) {
          const idx = this.chart.elements.indexOf(newChartElement);
          this.chartState.elements[idx].attributes[key] = value;
          if (!elementClass.attributes[key].solverExclude) {
            this.addPresolveValue(
              Solver.ConstraintStrength.HARD,
              this.chartState.elements[idx].attributes,
              key,
              value as number
            );
          }
        }
      }
    }

    this.currentSelection = new ChartElementSelection(newChartElement);
    this.emit(AppStore.EVENT_SELECTION);

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetPlotSegmentFilter, function(action) {
    this.saveHistory();
    action.plotSegment.filter = action.filter;
    // Filter updated, we need to regenerate some glyph states
    this.chartManager.remapPlotSegmentGlyphs(action.plotSegment);
    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetPlotSegmentGroupBy, function(action) {
    this.saveHistory();
    action.plotSegment.groupBy = action.groupBy;
    // Filter updated, we need to regenerate some glyph states
    this.chartManager.remapPlotSegmentGlyphs(action.plotSegment);
    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.UpdateChartElementAttribute, function(action) {
    this.saveHistory();

    const idx = this.chart.elements.indexOf(action.chartElement);
    if (idx < 0) {
      return;
    }
    const layoutState = this.chartState.elements[idx];
    for (const key in action.updates) {
      if (!action.updates.hasOwnProperty(key)) {
        continue;
      }
      // Remove current mapping and any snapping constraint
      delete action.chartElement.mappings[key];
      this.chart.constraints = this.chart.constraints.filter(c => {
        if (c.type == "snap") {
          if (
            c.attributes.element == action.chartElement._id &&
            c.attributes.attribute == key
          ) {
            return false;
          }
        }
        return true;
      });
      layoutState.attributes[key] = action.updates[key];
      this.addPresolveValue(
        Solver.ConstraintStrength.STRONG,
        layoutState.attributes,
        key,
        action.updates[key] as number
      );
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetChartElementMapping, function(action) {
    this.saveHistory();

    if (action.mapping == null) {
      delete action.chartElement.mappings[action.attribute];
    } else {
      action.chartElement.mappings[action.attribute] = action.mapping;
      this.chart.constraints = this.chart.constraints.filter(c => {
        if (c.type == "snap") {
          if (
            c.attributes.element == action.chartElement._id &&
            c.attributes.attribute == action.attribute
          ) {
            return false;
          }
        }
        return true;
      });
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SnapChartElements, function(action) {
    this.saveHistory();

    delete action.element.mappings[action.attribute];
    // Remove any existing snapping
    this.chart.constraints = this.chart.constraints.filter(c => {
      if (c.type == "snap") {
        if (
          c.attributes.element == action.element._id &&
          c.attributes.attribute == action.attribute
        ) {
          return false;
        }
      }
      return true;
    });
    this.chart.constraints.push({
      type: "snap",
      attributes: {
        element: action.element._id,
        attribute: action.attribute,
        targetElement: action.targetElement._id,
        targetAttribute: action.targetAttribute,
        gap: 0
      }
    });

    this.addPresolveValue(
      Solver.ConstraintStrength.STRONG,
      this.chartManager.getClassById(action.element._id).state.attributes,
      action.attribute,
      this.chartManager.getClassById(action.targetElement._id).state.attributes[
        action.targetAttribute
      ] as number
    );

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetScaleAttribute, function(action) {
    this.saveHistory();

    if (action.mapping == null) {
      delete action.scale.mappings[action.attribute];
    } else {
      action.scale.mappings[action.attribute] = action.mapping;
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.UpdateChartAttribute, function(action) {
    this.saveHistory();

    for (const key in action.updates) {
      if (!action.updates.hasOwnProperty(key)) {
        continue;
      }
      this.chartState.attributes[key] = action.updates[key];
      this.addPresolveValue(
        Solver.ConstraintStrength.STRONG,
        this.chartState.attributes,
        key,
        action.updates[key] as number
      );
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.BindDataToAxis, function(action) {
    this.saveHistory();
    const groupExpression = action.dataExpression.expression;
    let dataBinding: Specification.Types.AxisDataBinding = {
      type: "categorical",
      expression: groupExpression,
      valueType: action.dataExpression.valueType,
      gapRatio: 0.1,
      visible: true,
      side: "default",
      style: deepClone(Prototypes.PlotSegments.defaultAxisStyle)
    };

    let expressions = [groupExpression];

    if (action.appendToProperty) {
      if (action.object.properties[action.appendToProperty] == null) {
        action.object.properties[action.appendToProperty] = [
          { name: uniqueID(), expression: groupExpression }
        ];
      } else {
        (action.object.properties[action.appendToProperty] as any[]).push({
          name: uniqueID(),
          expression: groupExpression
        });
      }
      expressions = (action.object.properties[
        action.appendToProperty
      ] as any[]).map(x => x.expression);
      if (action.object.properties[action.property] == null) {
        action.object.properties[action.property] = dataBinding;
      } else {
        dataBinding = action.object.properties[
          action.property
        ] as Specification.Types.AxisDataBinding;
      }
    } else {
      action.object.properties[action.property] = dataBinding;
    }

    let groupBy: Specification.Types.GroupBy = null;
    if (Prototypes.isType(action.object.classID, "plot-segment")) {
      groupBy = (action.object as Specification.PlotSegment).groupBy;
    } else {
      // Find groupBy for data-driven guide
      if (Prototypes.isType(action.object.classID, "mark")) {
        for (const glyph of this.chart.glyphs) {
          if (glyph.marks.indexOf(action.object) >= 0) {
            // Found the glyph
            this.chartManager.enumeratePlotSegments(cls => {
              if (cls.object.glyph == glyph._id) {
                groupBy = cls.object.groupBy;
              }
            });
          }
        }
      }
    }
    let values: ValueType[] = [];
    for (const expr of expressions) {
      const r = this.chartManager.getGroupedExpressionVector(
        action.dataExpression.table.name,
        groupBy,
        expr
      );
      values = values.concat(r);
    }

    switch (action.dataExpression.metadata.kind) {
      case Specification.DataKind.Categorical:
      case Specification.DataKind.Ordinal:
        {
          dataBinding.type = "categorical";
          dataBinding.valueType = Specification.DataType.String;

          if (action.dataExpression.metadata.order) {
            dataBinding.categories = action.dataExpression.metadata.order.slice();
          } else {
            const scale = new Scale.CategoricalScale();
            let orderMode: "alphabetically" | "occurrence" | "order" =
              "alphabetically";
            if (action.dataExpression.metadata.orderMode) {
              orderMode = action.dataExpression.metadata.orderMode;
            }
            scale.inferParameters(values as string[], orderMode);
            dataBinding.categories = new Array<string>(scale.length);
            scale.domain.forEach(
              (index, x) => (dataBinding.categories[index] = x.toString())
            );
          }
        }
        break;
      case Specification.DataKind.Numerical:
        {
          const scale = new Scale.LinearScale();
          scale.inferParameters(values as number[]);
          dataBinding.domainMin = scale.domainMin;
          dataBinding.domainMax = scale.domainMax;
          dataBinding.type = "numerical";
          dataBinding.numericalMode = "linear";
        }
        break;
      case Specification.DataKind.Temporal:
        {
          const scale = new Scale.DateScale();
          scale.inferParameters(values as number[]);
          dataBinding.domainMin = scale.domainMin;
          dataBinding.domainMax = scale.domainMax;
          dataBinding.type = "numerical";
          dataBinding.numericalMode = "temporal";
        }
        break;
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetChartAttribute, function(action) {
    this.saveHistory();

    if (action.mapping == null) {
      delete this.chart.mappings[action.attribute];
    } else {
      this.chart.mappings[action.attribute] = action.mapping;
    }

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetChartSize, function(action) {
    this.saveHistory();

    this.chartState.attributes.width = action.width;
    this.chartState.attributes.height = action.height;
    this.chart.mappings.width = {
      type: "value",
      value: action.width
    } as Specification.ValueMapping;
    this.chart.mappings.height = {
      type: "value",
      value: action.height
    } as Specification.ValueMapping;

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.SetObjectProperty, function(action) {
    this.saveHistory();

    if (action.field == null) {
      action.object.properties[action.property] = action.value;
    } else {
      const obj = action.object.properties[action.property];
      action.object.properties[action.property] = setField(
        obj,
        action.field,
        action.value
      );
    }

    if (action.noUpdateState) {
      this.emit(AppStore.EVENT_GRAPHICS);
    } else {
      this.solveConstraintsAndUpdateGraphics(action.noComputeLayout);
    }
  });

  REG.add(Actions.ExtendPlotSegment, function(action) {
    this.saveHistory();

    const plotSegment = action.plotSegment as Specification.PlotSegment;
    const plotSegmentState = this.chartState.elements[
      this.chart.elements.indexOf(plotSegment)
    ] as Specification.PlotSegmentState;

    let newClassID: string;
    switch (action.extension) {
      case "cartesian-x": {
        newClassID = "plot-segment.cartesian";
      }
      case "cartesian-y":
        {
          newClassID = plotSegment.classID;
        }
        break;
      case "polar":
        {
          newClassID = "plot-segment.polar";
        }
        break;
      case "curve":
        {
          newClassID = "plot-segment.curve";
        }
        break;
    }
    if (plotSegment.classID != newClassID) {
      const originalAttributes = plotSegment.mappings;
      plotSegment.classID = newClassID;
      plotSegment.mappings = {};

      if (originalAttributes.x1) {
        plotSegment.mappings.x1 = originalAttributes.x1;
      }
      if (originalAttributes.x2) {
        plotSegment.mappings.x2 = originalAttributes.x2;
      }
      if (originalAttributes.y1) {
        plotSegment.mappings.y1 = originalAttributes.y1;
      }
      if (originalAttributes.y2) {
        plotSegment.mappings.y2 = originalAttributes.y2;
      }

      plotSegment.properties = {
        name: plotSegment.properties.name,
        visible: plotSegment.properties.visible,
        sublayout: plotSegment.properties.sublayout,
        xData: plotSegment.properties.xData,
        yData: plotSegment.properties.yData,
        marginX1: plotSegment.properties.marginX1,
        marginY1: plotSegment.properties.marginY1,
        marginX2: plotSegment.properties.marginX2,
        marginY2: plotSegment.properties.marginY2
      };

      if (newClassID == "plot-segment.polar") {
        plotSegment.properties.startAngle =
          Prototypes.PlotSegments.PolarPlotSegment.defaultProperties.startAngle;
        plotSegment.properties.endAngle =
          Prototypes.PlotSegments.PolarPlotSegment.defaultProperties.endAngle;
        plotSegment.properties.innerRatio =
          Prototypes.PlotSegments.PolarPlotSegment.defaultProperties.innerRatio;
        plotSegment.properties.outerRatio =
          Prototypes.PlotSegments.PolarPlotSegment.defaultProperties.outerRatio;
      }
      if ((newClassID = "plot-segment.curve")) {
        plotSegment.properties.curve =
          Prototypes.PlotSegments.CurvePlotSegment.defaultProperties.curve;
        plotSegment.properties.normalStart =
          Prototypes.PlotSegments.CurvePlotSegment.defaultProperties.normalStart;
        plotSegment.properties.normalEnd =
          Prototypes.PlotSegments.CurvePlotSegment.defaultProperties.normalEnd;
      }

      this.chartManager.initializeCache();
      const layoutClass = this.chartManager.getPlotSegmentClass(
        plotSegmentState
      );
      plotSegmentState.attributes = {};
      layoutClass.initializeState();
    } else {
      if (
        action.extension == "cartesian-x" ||
        action.extension == "polar" ||
        action.extension == "curve"
      ) {
        // if (plotSegment.properties.xData == null) {
        plotSegment.properties.xData = { type: "default", gapRatio: 0.1 };
        // }
      }
      if (action.extension == "cartesian-y") {
        // if (plotSegment.properties.yData == null) {
        plotSegment.properties.yData = { type: "default", gapRatio: 0.1 };
        // }
      }
    }
    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.ReorderGlyphMark, function(action) {
    this.saveHistory();

    this.chartManager.reorderGlyphElement(
      action.glyph,
      action.fromIndex,
      action.toIndex
    );

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.ToggleLegendForScale, function(action) {
    this.saveHistory();

    this.toggleLegendForScale(action.scale);

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.ReorderChartElement, function(action) {
    this.saveHistory();

    this.chartManager.reorderChartElement(action.fromIndex, action.toIndex);

    this.solveConstraintsAndUpdateGraphics();
  });

  REG.add(Actions.AddLinks, function(action) {
    this.saveHistory();

    action.links.properties.name = this.chartManager.findUnusedName("Link");
    this.chartManager.addChartElement(action.links);
    const selection = new ChartElementSelection(action.links);
    this.currentSelection = selection;

    // Note: currently, links has no constraints to solve
    this.emit(AppStore.EVENT_GRAPHICS);
    this.emit(AppStore.EVENT_SELECTION);
  });

  REG.add(Actions.DeleteChartElement, function(action) {
    this.saveHistory();

    if (
      this.currentSelection instanceof ChartElementSelection &&
      this.currentSelection.chartElement == action.chartElement
    ) {
      this.currentSelection = null;
      this.emit(AppStore.EVENT_SELECTION);
    }
    this.chartManager.removeChartElement(action.chartElement);

    this.solveConstraintsAndUpdateGraphics();
  });
}