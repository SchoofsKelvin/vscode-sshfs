import * as React from 'react';
import { connect } from '../redux';
import { FieldBase } from './base';
import { FieldDropdown } from './dropdown';
import { FieldDropdownWithInput } from './dropdownwithinput';
import { FieldString } from './string';

// Maybe in the future we can make this generic, but we'd have to make FieldDropdown etc also generic first
type T = string;

// TODO: Allow reordering of items

export interface Props<T> {
    options?: T[];
    freeText?: boolean;
    //displayName?(item: T): string;
    displayStyle?(item: T): React.CSSProperties;
}
interface State {
    open: boolean;
    inputText: string;
}
export class FieldList extends FieldBase<T[] | undefined, Props<T>, State> {
    public getInitialSubState(props: Props<string>): State {
        return { open: false, inputText: '' };
    }
    protected renderNewInputField(): React.ReactNode {
        const { inputText } = this.state;
        const { freeText, options, displayStyle } = this.props;
        const FD = options?.length ? (freeText ? FieldDropdownWithInput : FieldDropdown) : (freeText ? FieldString : undefined);
        return FD && <FD value={inputText} values={options} displayStyle={displayStyle}
            onChange={t => this.setState({ inputText: t || '' })} />;
    }
    public renderInput(): React.ReactNode {
        const { newValue } = this.state;
        const { displayStyle } = this.props;
        const newInput = this.renderNewInputField();
        return <div className="FieldList">
            {newInput && <div className="adder">{newInput}<button onClick={this.onAdd}>+</button></div>}
            {newValue?.map((item, index) => <li key={index} style={displayStyle?.(item)}>
                <p>{item}</p>
                <button onClick={this.onRemove.bind(this, index)}>x</button>
            </li>)}
        </div>;
    }
    protected onAdd = () => {
        const inputText = this.state.inputText?.trim();
        if (!inputText) return;
        this.setState({
            inputText: '',
            newValue: [...this.state.newValue || [], inputText]
        }, () => this.props.onChange(this.state.newValue));
    };
    protected onRemove = (index: number) => {
        const newValue = [...this.state.newValue || []];
        newValue.splice(index, 1);
        this.setState({ newValue }, () => this.props.onChange(newValue));
    };
}

export type FieldConfigListState = { options: string[] };
export const FieldConfigList = connect(FieldList)<FieldConfigListState>(
    state => ({ options: state.data.configs.map(c => c.name).sort() }),
);
