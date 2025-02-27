import { compact, flatten, head } from 'lodash';
import * as ts from 'typescript';
import { ApiHideProperty } from '../../decorators';
import { PluginOptions } from '../merge-options';
import { METADATA_FACTORY_NAME } from '../plugin-constants';
import {
  createBooleanLiteral,
  createPrimitiveLiteral,
  getDecoratorArguments,
  getMainCommentAndExamplesOfNode,
  getText,
  isEnum
} from '../utils/ast-utils';
import {
  extractTypeArgumentIfArray,
  getDecoratorOrUndefinedByNames,
  getTypeReferenceAsString,
  hasPropertyKey,
  isAutoGeneratedEnumUnion,
  isAutoGeneratedTypeUnion,
  replaceImportPath
} from '../utils/plugin-utils';
import { AbstractFileVisitor } from './abstract.visitor';

type ClassMetadata = Record<string, ts.ObjectLiteralExpression>;

export class ModelClassVisitor extends AbstractFileVisitor {
  visit(
    sourceFile: ts.SourceFile,
    ctx: ts.TransformationContext,
    program: ts.Program,
    options: PluginOptions
  ) {
    const typeChecker = program.getTypeChecker();
    sourceFile = this.updateImports(sourceFile, ctx.factory);

    const propertyNodeVisitorFactory =
      (metadata: ClassMetadata) =>
      (node: ts.Node): ts.Node => {
        if (ts.isPropertyDeclaration(node)) {
          const decorators = node.decorators;
          const hidePropertyDecorator = getDecoratorOrUndefinedByNames(
            [ApiHideProperty.name],
            decorators
          );
          if (hidePropertyDecorator) {
            return node;
          }

          const isPropertyStatic = (node.modifiers || []).some(
            (modifier: ts.Modifier) =>
              modifier.kind === ts.SyntaxKind.StaticKeyword
          );
          if (isPropertyStatic) {
            return node;
          }
          try {
            this.inspectPropertyDeclaration(
              ctx.factory,
              node,
              typeChecker,
              options,
              sourceFile.fileName,
              sourceFile,
              metadata
            );
          } catch (err) {
            return node;
          }
        }
        return node;
      };

    const visitClassNode = (node: ts.Node): ts.Node => {
      if (ts.isClassDeclaration(node)) {
        const metadata: ClassMetadata = {};
        node = ts.visitEachChild(
          node,
          propertyNodeVisitorFactory(metadata),
          ctx
        );
        return this.addMetadataFactory(
          ctx.factory,
          node as ts.ClassDeclaration,
          metadata
        );
      }
      return ts.visitEachChild(node, visitClassNode, ctx);
    };
    return ts.visitNode(sourceFile, visitClassNode);
  }

  addMetadataFactory(
    factory: ts.NodeFactory,
    node: ts.ClassDeclaration,
    classMetadata: ClassMetadata
  ) {
    const returnValue = factory.createObjectLiteralExpression(
      Object.keys(classMetadata).map((key) =>
        factory.createPropertyAssignment(
          factory.createIdentifier(key),
          classMetadata[key]
        )
      )
    );
    const method = factory.createMethodDeclaration(
      undefined,
      [factory.createModifier(ts.SyntaxKind.StaticKeyword)],
      undefined,
      factory.createIdentifier(METADATA_FACTORY_NAME),
      undefined,
      undefined,
      [],
      undefined,
      factory.createBlock([factory.createReturnStatement(returnValue)], true)
    );

    return factory.updateClassDeclaration(
      node,
      node.decorators,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.heritageClauses,
      [...node.members, method]
    );
  }

  inspectPropertyDeclaration(
    factory: ts.NodeFactory,
    compilerNode: ts.PropertyDeclaration,
    typeChecker: ts.TypeChecker,
    options: PluginOptions,
    hostFilename: string,
    sourceFile: ts.SourceFile,
    metadata: ClassMetadata
  ) {
    const objectLiteralExpr = this.createDecoratorObjectLiteralExpr(
      factory,
      compilerNode,
      typeChecker,
      factory.createNodeArray(),
      options,
      hostFilename,
      sourceFile
    );
    this.addClassMetadata(
      compilerNode,
      objectLiteralExpr,
      sourceFile,
      metadata
    );
  }

  createDecoratorObjectLiteralExpr(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment> = factory.createNodeArray(),
    options: PluginOptions = {},
    hostFilename = '',
    sourceFile?: ts.SourceFile
  ): ts.ObjectLiteralExpression {
    const isRequired = !node.questionToken;

    let properties = [
      ...existingProperties,
      !hasPropertyKey('required', existingProperties) &&
        factory.createPropertyAssignment(
          'required',
          createBooleanLiteral(factory, isRequired)
        ),
      ...this.createTypePropertyAssignments(
        factory,
        node.type,
        typeChecker,
        existingProperties,
        hostFilename
      ),
      ...this.createDescriptionAndExamplePropertyAssigments(
        factory,
        node,
        typeChecker,
        existingProperties,
        options,
        sourceFile
      ),
      this.createDefaultPropertyAssignment(factory, node, existingProperties),
      this.createEnumPropertyAssignment(
        factory,
        node,
        typeChecker,
        existingProperties,
        hostFilename
      )
    ];
    if (options.classValidatorShim) {
      properties = properties.concat(
        this.createValidationPropertyAssignments(factory, node)
      );
    }
    return factory.createObjectLiteralExpression(compact(flatten(properties)));
  }

  /**
   * The function returns an array with 0, 1 or 2 PropertyAssignments.
   * Possible keys:
   * - 'type'
   * - 'nullable'
   */
  private createTypePropertyAssignments(
    factory: ts.NodeFactory,
    node: ts.TypeNode,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    hostFilename: string
  ): ts.PropertyAssignment[] {
    const key = 'type';
    if (hasPropertyKey(key, existingProperties)) {
      return [];
    }
    if (node) {
      if (ts.isTypeLiteralNode(node)) {
        const propertyAssignments = Array.from(node.members || []).map(
          (member) => {
            const literalExpr = this.createDecoratorObjectLiteralExpr(
              factory,
              member as ts.PropertySignature,
              typeChecker,
              existingProperties,
              {},
              hostFilename
            );
            return factory.createPropertyAssignment(
              factory.createIdentifier(member.name.getText()),
              literalExpr
            );
          }
        );
        return [
          factory.createPropertyAssignment(
            key,
            factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              undefined,
              factory.createParenthesizedExpression(
                factory.createObjectLiteralExpression(propertyAssignments)
              )
            )
          )
        ];
      } else if (ts.isUnionTypeNode(node)) {
        const nullableType = node.types.find(
          (type) =>
            type.kind === ts.SyntaxKind.NullKeyword ||
            (ts.SyntaxKind.LiteralType && type.getText() === 'null')
        );
        const isNullable = !!nullableType;
        const remainingTypes = node.types.filter(
          (item) => item !== nullableType
        );

        // When we have more than 1 type left, we could use oneOf
        if (remainingTypes.length === 1) {
          const remainingTypesProperties = this.createTypePropertyAssignments(
            factory,
            remainingTypes[0],
            typeChecker,
            existingProperties,
            hostFilename
          );

          const resultArray = new Array<ts.PropertyAssignment>(
            ...remainingTypesProperties
          );
          if (isNullable) {
            const nullablePropertyAssignment = factory.createPropertyAssignment(
              'nullable',
              createBooleanLiteral(factory, true)
            );
            resultArray.push(nullablePropertyAssignment);
          }
          return resultArray;
        }
      }
    }

    const type = typeChecker.getTypeAtLocation(node);
    if (!type) {
      return [];
    }
    let typeReference = getTypeReferenceAsString(type, typeChecker);
    if (!typeReference) {
      return [];
    }
    typeReference = replaceImportPath(typeReference, hostFilename);
    return [
      factory.createPropertyAssignment(
        key,
        factory.createArrowFunction(
          undefined,
          undefined,
          [],
          undefined,
          undefined,
          factory.createIdentifier(typeReference)
        )
      )
    ];
  }

  createEnumPropertyAssignment(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    hostFilename: string
  ) {
    const key = 'enum';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    let type = typeChecker.getTypeAtLocation(node);
    if (!type) {
      return undefined;
    }
    if (isAutoGeneratedTypeUnion(type)) {
      const types = (type as ts.UnionOrIntersectionType).types;
      type = types[types.length - 1];
    }
    const typeIsArrayTuple = extractTypeArgumentIfArray(type);
    if (!typeIsArrayTuple) {
      return undefined;
    }
    let isArrayType = typeIsArrayTuple.isArray;
    type = typeIsArrayTuple.type;

    const isEnumMember =
      type.symbol && type.symbol.flags === ts.SymbolFlags.EnumMember;
    if (!isEnum(type) || isEnumMember) {
      if (!isEnumMember) {
        type = isAutoGeneratedEnumUnion(type, typeChecker);
      }
      if (!type) {
        return undefined;
      }
      const typeIsArrayTuple = extractTypeArgumentIfArray(type);
      if (!typeIsArrayTuple) {
        return undefined;
      }
      isArrayType = typeIsArrayTuple.isArray;
      type = typeIsArrayTuple.type;
    }
    const enumRef = replaceImportPath(getText(type, typeChecker), hostFilename);
    const enumProperty = factory.createPropertyAssignment(
      key,
      factory.createIdentifier(enumRef)
    );
    if (isArrayType) {
      const isArrayKey = 'isArray';
      const isArrayProperty = factory.createPropertyAssignment(
        isArrayKey,
        factory.createIdentifier('true')
      );
      return [enumProperty, isArrayProperty];
    }
    return enumProperty;
  }

  createDefaultPropertyAssignment(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>
  ) {
    const key = 'default';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    let initializer = node.initializer;
    if (!initializer) {
      return undefined;
    }
    if (ts.isAsExpression(initializer)) {
      initializer = initializer.expression;
    }
    return factory.createPropertyAssignment(key, initializer);
  }

  createValidationPropertyAssignments(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature
  ): ts.PropertyAssignment[] {
    const assignments = [];
    const decorators = node.decorators;

    this.addPropertyByValidationDecorator(
      factory,
      'Min',
      'minimum',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      factory,
      'Max',
      'maximum',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      factory,
      'MinLength',
      'minLength',
      decorators,
      assignments
    );
    this.addPropertyByValidationDecorator(
      factory,
      'MaxLength',
      'maxLength',
      decorators,
      assignments
    );

    return assignments;
  }

  addPropertyByValidationDecorator(
    factory: ts.NodeFactory,
    decoratorName: string,
    propertyKey: string,
    decorators: ts.NodeArray<ts.Decorator>,
    assignments: ts.PropertyAssignment[]
  ) {
    const decoratorRef = getDecoratorOrUndefinedByNames(
      [decoratorName],
      decorators
    );
    if (!decoratorRef) {
      return;
    }
    const argument: ts.Expression = head(getDecoratorArguments(decoratorRef));
    if (argument) {
      assignments.push(factory.createPropertyAssignment(propertyKey, argument));
    }
  }

  addClassMetadata(
    node: ts.PropertyDeclaration,
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    metadata: ClassMetadata
  ) {
    const hostClass = node.parent;
    const className = hostClass.name && hostClass.name.getText();
    if (!className) {
      return;
    }
    const propertyName = node.name && node.name.getText(sourceFile);
    if (
      !propertyName ||
      (node.name && node.name.kind === ts.SyntaxKind.ComputedPropertyName)
    ) {
      return;
    }
    metadata[propertyName] = objectLiteral;
  }

  createDescriptionAndExamplePropertyAssigments(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment> = factory.createNodeArray(),
    options: PluginOptions = {},
    sourceFile?: ts.SourceFile
  ): ts.PropertyAssignment[] {
    if (!options.introspectComments || !sourceFile) {
      return [];
    }
    const propertyAssignments = [];
    const [comments, examples] = getMainCommentAndExamplesOfNode(
      node,
      sourceFile,
      typeChecker,
      true
    );

    const keyOfComment = options.dtoKeyOfComment;
    if (!hasPropertyKey(keyOfComment, existingProperties) && comments) {
      const descriptionPropertyAssignment = factory.createPropertyAssignment(
        keyOfComment,
        factory.createStringLiteral(comments)
      );
      propertyAssignments.push(descriptionPropertyAssignment);
    }

    const hasExampleOrExamplesKey =
      hasPropertyKey('example', existingProperties) ||
      hasPropertyKey('examples', existingProperties);

    if (!hasExampleOrExamplesKey && examples.length) {
      if (examples.length === 1) {
        const examplePropertyAssignment = factory.createPropertyAssignment(
          'example',
          this.createLiteralFromAnyValue(factory, examples[0])
        );
        propertyAssignments.push(examplePropertyAssignment);
      } else {
        const examplesPropertyAssignment = factory.createPropertyAssignment(
          'examples',
          this.createLiteralFromAnyValue(factory, examples)
        );
        propertyAssignments.push(examplesPropertyAssignment);
      }
    }
    return propertyAssignments;
  }

  private createLiteralFromAnyValue(factory: ts.NodeFactory, item: unknown) {
    return Array.isArray(item)
      ? factory.createArrayLiteralExpression(
          item.map((item) => this.createLiteralFromAnyValue(factory, item))
        )
      : createPrimitiveLiteral(factory, item);
  }
}
