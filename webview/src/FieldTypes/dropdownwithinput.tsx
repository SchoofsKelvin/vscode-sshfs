import * as React from 'react';
import { FieldBase } from './base';

interface Props {
    values: string[];
    optional?: boolean;
    displayStyle?(item?: string): React.CSSProperties;
}
interface State {
    open: boolean;
}
export class FieldDropdownWithInput extends FieldBase<string | undefined, Props, State> {
    public mainDivRef = React.createRef<HTMLDivElement>();
    public componentDidMount() {
        window.addEventListener('click', this.onGlobalClick);
    }
    public componentWillUnmount() {
        window.removeEventListener('click', this.onGlobalClick);
    }
    public getInitialSubState(props: Props): State {
        return { open: false };
    }
    public renderInput() {
        const { newValue, open } = this.state;
        return <div className="FieldDropdown FieldDropdownWithInput" ref={this.mainDivRef}>
            <p className="arrow" onClick={this.toggle}>▼</p>
            <input className="current" value={newValue || ''} onChange={this.onChangeEvent} onClick={this.toggle} />
            {open && this.generateDropdown()}
        </div>;
    }
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value || undefined);
    }
    public generateDropdown() {
        const { displayStyle, values, optional } = this.props;
        const generateItem = (item: string | undefined, index: number) => {
            const style = displayStyle && displayStyle(item);
            return <li key={index} style={style} onClick={this.select.bind(this, item)}>
                {item}
            </li>
        };
        return <ul className="list">
            {optional && generateItem(undefined, -1)}
            {values.map(generateItem)}
        </ul>;
    }
    public select(newValue: string | undefined) {
        this.setState({ newValue, open: false }, () => this.props.onChange(newValue));
    }
    public toggle = () => this.setState({ open: !this.state.open });
    public onGlobalClick = (event: MouseEvent) => {
        if (!this.state.open) return;
        if (event.composedPath().includes(this.mainDivRef.current!)) return;
        this.toggle();
    };
}
