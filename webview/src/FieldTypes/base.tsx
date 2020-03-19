import * as React from 'react';
import { FieldGroup } from './group';
import './index.css';

interface Props<T> {
    label: string;
    description?: string;
    value: T;
    optional?: boolean;
    group?: FieldGroup;
    validator?(value: T): string | null;
    onChange(newValue?: T): void;
}
interface State<T> {
    oldValue: T;
    newValue?: T;
}

type WrappedState<T, S> = {
    [key in keyof S]: key extends keyof State<T> ? State<T>[key] : S[key];
} & State<T>;

export abstract class FieldBase<T, P = {}, S = {}> extends React.Component<Props<T> & P, WrappedState<T, S>> {
    constructor(props: Props<T> & P) {
        super(props);
        this.state = {
            newValue: props.value,
            oldValue: props.value,
            ...this.getInitialSubState(props) as any,
        }
    }
    public getInitialSubState(props: Props<T> & P): S {
        return {} as S;
    }
    public onChange = (newValue?: T) => {
        this.setState({ newValue }, () => this.props.onChange(newValue));
    }
    public componentDidUpdate(oldProps: Props<T>) {
        const { value } = this.props;
        if (oldProps.value === value) return;
        this.setState({ oldValue: value, newValue: value });
    }
    public abstract renderInput(): React.ReactNode;
    public getError(): string | null {
        const { newValue } = this.state;
        const { validator, optional } = this.props;
        if (newValue === undefined) {
            if (optional) return null;
            return 'No value given';
        }
        return validator ? validator(newValue!) : null;
    }
    public getValue(): T | undefined {
        const { newValue, oldValue } = this.state;
        if (newValue === undefined) {
            return this.props.optional ? newValue : oldValue;
        }
        return newValue!;
    }
    public getLabel() {
        return this.props.label;
    }
    public render() {
        const error = this.getError();
        const { description, label, optional } = this.props;
        return <div className="Field">
            <FieldGroup.Consumer>{group => (group && group.register(this), [])}</FieldGroup.Consumer>
            <div className="label">{label}</div>{optional && <div className="optional">Optional</div>}
            {description && <div className="description">{description}</div>}
            {error && <div className="error">{error}</div>}
            <div className="value">
                {this.renderInput()}
            </div>
        </div>;
    }
}
