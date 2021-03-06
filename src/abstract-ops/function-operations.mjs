import {
  surroundingAgent,
  // Suspend,
  ExecutionContext,
} from '../engine.mjs';
import { Realm } from '../realm.mjs';
import {
  BuiltinFunctionValue,
  Descriptor,
  FunctionValue,
  Type,
  Value,
} from '../value.mjs';
import {
  EnsureCompletion, NormalCompletion, Q,
  ReturnIfAbrupt,
  X,
} from '../completion.mjs';
import { ExpectedArgumentCount } from '../static-semantics/all.mjs';
import {
  EvaluateBody_AsyncConciseBody_ExpressionBody,
  EvaluateBody_AsyncFunctionBody,
  EvaluateBody_ConciseBody_ExpressionBody,
  EvaluateBody_FunctionBody,
  EvaluateBody_GeneratorBody,
  EvaluateBody_AsyncGeneratorBody,
  getFunctionBodyType,
} from '../runtime-semantics/all.mjs';
import {
  FunctionEnvironmentRecord,
  GlobalEnvironmentRecord,
  NewFunctionEnvironment,
} from '../environment.mjs';
import { unwind, OutOfRange } from '../helpers.mjs';
import {
  Assert,
  DefinePropertyOrThrow,
  GetActiveScriptOrModule,
  HasOwnProperty,
  IsConstructor,
  IsExtensible,
  IsInteger,
  ObjectCreate,
  OrdinaryCreateFromConstructor,
  ToObject,
  isStrictModeCode,
} from './all.mjs';

// This file covers abstract operations defined in
// 9.2 #sec-ecmascript-function-objects
// 9.3 #sec-built-in-function-objects
// and
// 14.9 #sec-tail-position-calls

// 9.2.1.1 #sec-prepareforordinarycall
function PrepareForOrdinaryCall(F, newTarget) {
  Assert(Type(newTarget) === 'Undefined' || Type(newTarget) === 'Object');
  // const callerContext = surroundingAgent.runningExecutionContext;
  const calleeContext = new ExecutionContext();
  calleeContext.Function = F;
  const calleeRealm = F.Realm;
  calleeContext.Realm = calleeRealm;
  calleeContext.ScriptOrModule = F.ScriptOrModule;
  const localEnv = NewFunctionEnvironment(F, newTarget);
  calleeContext.LexicalEnvironment = localEnv;
  calleeContext.VariableEnvironment = localEnv;
  // Suspend(callerContext);
  surroundingAgent.executionContextStack.push(calleeContext);
  return calleeContext;
}

// 9.2.1.2 #sec-ordinarycallbindthis
function OrdinaryCallBindThis(F, calleeContext, thisArgument) {
  const thisMode = F.ThisMode;
  if (thisMode === 'lexical') {
    return new NormalCompletion(Value.undefined);
  }
  const calleeRealm = F.Realm;
  const localEnv = calleeContext.LexicalEnvironment;
  let thisValue;
  if (thisMode === 'strict') {
    thisValue = thisArgument;
  } else {
    if (thisArgument === Value.undefined || thisArgument === Value.null) {
      const globalEnv = calleeRealm.GlobalEnv;
      const globalEnvRec = globalEnv.EnvironmentRecord;
      Assert(globalEnvRec instanceof GlobalEnvironmentRecord);
      thisValue = globalEnvRec.GlobalThisValue;
    } else {
      thisValue = X(ToObject(thisArgument));
      // NOTE: ToObject produces wrapper objects using calleeRealm.
    }
  }
  const envRec = localEnv.EnvironmentRecord;
  Assert(envRec instanceof FunctionEnvironmentRecord);
  Assert(envRec.ThisBindingStatus !== 'initialized');
  return envRec.BindThisValue(thisValue);
}

// 9.2.1.3 #sec-ordinarycallevaluatebody
export function* OrdinaryCallEvaluateBody(F, argumentsList) {
  switch (getFunctionBodyType(F.ECMAScriptCode)) {
    // FunctionBody : FunctionStatementList
    // ConciseBody : `{` FunctionBody `}`
    case 'FunctionBody':
    case 'ConciseBody_FunctionBody':
      return yield* EvaluateBody_FunctionBody(F.ECMAScriptCode.body.body, F, argumentsList);

    // ConciseBody : ExpressionBody
    case 'ConciseBody_ExpressionBody':
      return yield* EvaluateBody_ConciseBody_ExpressionBody(F.ECMAScriptCode.body, F, argumentsList);

    case 'GeneratorBody':
      return yield* EvaluateBody_GeneratorBody(F.ECMAScriptCode.body.body, F, argumentsList);

    case 'AsyncFunctionBody':
    case 'AsyncConciseBody_AsyncFunctionBody':
      return yield* EvaluateBody_AsyncFunctionBody(F.ECMAScriptCode.body.body, F, argumentsList);

    case 'AsyncConciseBody_ExpressionBody':
      return yield* EvaluateBody_AsyncConciseBody_ExpressionBody(F.ECMAScriptCode.body, F, argumentsList);

    case 'AsyncGeneratorBody':
      return yield* EvaluateBody_AsyncGeneratorBody(F.ECMAScriptCode.body.body, F, argumentsList);

    default:
      throw new OutOfRange('OrdinaryCallEvaluateBody', F.ECMAScriptCode);
  }
}

// 9.2.1 #sec-ecmascript-function-objects-call-thisargument-argumentslist
function FunctionCallSlot(thisArgument, argumentsList) {
  const F = this;

  Assert(F instanceof FunctionValue);
  if (F.IsClassConstructor === Value.true) {
    return surroundingAgent.Throw('TypeError', 'ConstructorNonCallable', F);
  }
  // const callerContext = surroundingAgent.runningExecutionContext;
  const calleeContext = PrepareForOrdinaryCall(F, Value.undefined);
  Assert(surroundingAgent.runningExecutionContext === calleeContext);
  OrdinaryCallBindThis(F, calleeContext, thisArgument);
  const result = EnsureCompletion(unwind(OrdinaryCallEvaluateBody(F, argumentsList)));
  // Remove calleeContext from the execution context stack and
  // restore callerContext as the running execution context.
  surroundingAgent.executionContextStack.pop(calleeContext);
  if (result.Type === 'return') {
    return new NormalCompletion(result.Value);
  }
  ReturnIfAbrupt(result);
  return new NormalCompletion(Value.undefined);
}

// 9.2.2 #sec-ecmascript-function-objects-construct-argumentslist-newtarget
function FunctionConstructSlot(argumentsList, newTarget) {
  const F = this;

  Assert(F instanceof FunctionValue);
  Assert(Type(newTarget) === 'Object');
  // const callerContext = surroundingAgent.runningExecutionContext;
  const kind = F.ConstructorKind;
  let thisArgument;
  if (kind === 'base') {
    thisArgument = Q(OrdinaryCreateFromConstructor(newTarget, '%Object.prototype%'));
  }
  const calleeContext = PrepareForOrdinaryCall(F, newTarget);
  Assert(surroundingAgent.runningExecutionContext === calleeContext);
  surroundingAgent.runningExecutionContext.callSite.constructCall = true;
  if (kind === 'base') {
    OrdinaryCallBindThis(F, calleeContext, thisArgument);
  }
  const constructorEnv = calleeContext.LexicalEnvironment;
  const envRec = constructorEnv.EnvironmentRecord;
  const result = EnsureCompletion(unwind(OrdinaryCallEvaluateBody(F, argumentsList)));
  // Remove calleeContext from the execution context stack and
  // restore callerContext as the running execution context.
  surroundingAgent.executionContextStack.pop(calleeContext);
  if (result.Type === 'return') {
    if (Type(result.Value) === 'Object') {
      return new NormalCompletion(result.Value);
    }
    if (kind === 'base') {
      return new NormalCompletion(thisArgument);
    }
    if (Type(result.Value) !== 'Undefined') {
      return surroundingAgent.Throw('TypeError', 'DerivedConstructorReturnedNonObject');
    }
  } else {
    ReturnIfAbrupt(result);
  }
  return Q(envRec.GetThisBinding());
}

// 9.2 #sec-ecmascript-function-objects
const esFunctionInternalSlots = Object.freeze([
  'Environment',
  'FormalParameters',
  'ECMAScriptCode',
  'ConstructorKind',
  'Realm',
  'ScriptOrModule',
  'ThisMode',
  'Strict',
  'HomeObject',
  'IsClassConstructor',
]);

// 9.2.3 #sec-functionallocate
export function OrdinaryFunctionCreate(functionPrototype, ParameterList, Body, thisMode, Scope) {
  Assert(Type(functionPrototype) === 'Object');
  const F = new FunctionValue(functionPrototype);
  for (const internalSlot of esFunctionInternalSlots) {
    F[internalSlot] = Value.undefined;
  }
  F.Call = FunctionCallSlot;
  F.Prototype = functionPrototype;
  F.Extensible = Value.true;
  F.Environment = Scope;
  F.FormalParameters = ParameterList;
  F.ECMAScriptCode = Body;
  const Strict = isStrictModeCode(Body);
  F.Strict = Strict;
  if (thisMode === 'lexical-this') {
    F.ThisMode = 'lexical';
  } else if (Strict) {
    F.ThisMode = 'strict';
  } else {
    F.ThisMode = 'global';
  }
  F.IsClassConstructor = Value.false;
  F.Environment = Scope;
  F.ScriptOrModule = GetActiveScriptOrModule();
  F.Realm = surroundingAgent.currentRealmRecord;
  const len = ExpectedArgumentCount(ParameterList);
  X(SetFunctionLength(F, new Value(len)));
  return F;
}

// 9.2.10 #sec-makeconstructor
export function MakeConstructor(F, writablePrototype, prototype) {
  Assert(F instanceof FunctionValue);
  Assert(IsConstructor(F) === Value.false);
  Assert(X(IsExtensible(F)) === Value.true && X(HasOwnProperty(F, new Value('prototype'))) === Value.false);
  F.Construct = FunctionConstructSlot;
  F.ConstructorKind = 'base';
  if (writablePrototype === undefined) {
    writablePrototype = true;
  }
  if (prototype === undefined) {
    prototype = ObjectCreate(surroundingAgent.intrinsic('%Object.prototype%'));
    X(DefinePropertyOrThrow(prototype, new Value('constructor'), Descriptor({
      Value: F,
      Writable: writablePrototype ? Value.true : Value.false,
      Enumerable: Value.false,
      Configurable: Value.true,
    })));
  }
  X(DefinePropertyOrThrow(F, new Value('prototype'), Descriptor({
    Value: prototype,
    Writable: writablePrototype ? Value.true : Value.false,
    Enumerable: Value.false,
    Configurable: Value.false,
  })));
  return new NormalCompletion(Value.undefined);
}

// 9.2.11 #sec-makeclassconstructor
export function MakeClassConstructor(F) {
  Assert(F instanceof FunctionValue);
  Assert(F.IsClassConstructor === Value.false);
  F.IsClassConstructor = Value.true;
  return new NormalCompletion(Value.undefined);
}

// 9.2.12 #sec-makemethod
export function MakeMethod(F, homeObject) {
  Assert(F instanceof FunctionValue);
  Assert(Type(homeObject) === 'Object');
  F.HomeObject = homeObject;
  return new NormalCompletion(Value.undefined);
}

// 9.2.13 #sec-setfunctionname
export function SetFunctionName(F, name, prefix) {
  Assert(IsExtensible(F) === Value.true && HasOwnProperty(F, new Value('name')) === Value.false);
  Assert(Type(name) === 'Symbol' || Type(name) === 'String');
  Assert(!prefix || Type(prefix) === 'String');
  if (Type(name) === 'Symbol') {
    const description = name.Description;
    if (Type(description) === 'Undefined') {
      name = new Value('');
    } else {
      name = new Value(`[${description.stringValue()}]`);
    }
  }
  if (prefix !== undefined) {
    name = new Value(`${prefix.stringValue()} ${name.stringValue()}`);
  }
  return X(DefinePropertyOrThrow(F, new Value('name'), Descriptor({
    Value: name,
    Writable: Value.false,
    Enumerable: Value.false,
    Configurable: Value.true,
  })));
}

// 9.2.14 #sec-setfunctionlength
export function SetFunctionLength(F, length) {
  Assert(IsExtensible(F) === Value.true && HasOwnProperty(F, new Value('length')) === Value.false);
  Assert(Type(length) === 'Number');
  Assert(length.numberValue() >= 0 && X(IsInteger(length)) === Value.true);
  return X(DefinePropertyOrThrow(F, new Value('length'), Descriptor({
    Value: length,
    Writable: Value.false,
    Enumerable: Value.false,
    Configurable: Value.true,
  })));
}

// 9.3.3 #sec-createbuiltinfunction
export function CreateBuiltinFunction(steps, internalSlotsList, realm, prototype, isConstructor = Value.false) {
  Assert(typeof steps === 'function');
  if (realm === undefined) {
    realm = surroundingAgent.currentRealmRecord;
  }
  Assert(realm instanceof Realm);
  if (prototype === undefined) {
    prototype = realm.Intrinsics['%Function.prototype%'];
  }

  const func = new BuiltinFunctionValue(steps, isConstructor);
  for (const slot of internalSlotsList) {
    func[slot] = Value.undefined;
  }

  func.Realm = realm;
  func.Prototype = prototype;
  func.Extensible = Value.true;
  func.ScriptOrModule = Value.null;

  return func;
}

// 14.9.3 #sec-preparefortailcall
export function PrepareForTailCall() {
  // const leafContext = surroundingAgent.runningExecutionContext;
  // Suspend(leafContext);
  // surroundingAgent.executionContextStack.pop();
  // Assert: leafContext has no further use. It will never
  // be activated as the running execution context.
}
