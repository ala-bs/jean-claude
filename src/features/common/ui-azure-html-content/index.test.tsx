// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import {
  AzureHtmlContent,
  AzureMarkdownContent,
  AzureWorkItemDescription,
} from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ATTACHMENT_URL =
  'https://dev.azure.com/org/70ecf9b9-300f-48ea-a5a8-80d9c00b6209/_apis/wit/attachments/8f1f0b8a-1111-2222-3333-444455556666?fileName=image.png';

describe('AzureHtmlContent images', () => {
  it('renders an image for HTML comments whose markdown carries the Azure size suffix', () => {
    act(() => {
      root.render(
        <AzureHtmlContent
          html={`<div>![image.png](${ATTACHMENT_URL} =640x)</div>`}
          providerId="provider-1"
        />,
      );
    });

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toMatch(/^azure-image-proxy:\/\//);
    expect(container.textContent).not.toContain('![image.png]');
  });

  it('keeps the requested display width from the size suffix', () => {
    act(() => {
      root.render(
        <AzureHtmlContent
          html={`<div>![image.png](${ATTACHMENT_URL} =640x)</div>`}
          providerId="provider-1"
        />,
      );
    });

    expect(container.querySelector('img')?.style.width).toBe('640px');
  });
});

describe('AzureMarkdownContent images', () => {
  it('keeps the requested display width from the size suffix', () => {
    act(() => {
      root.render(
        <AzureMarkdownContent
          markdown={`![image.png](${ATTACHMENT_URL} =640x)`}
          providerId="provider-1"
        />,
      );
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toMatch(/^azure-image-proxy:\/\//);
    expect(image?.style.width).toBe('640px');
  });
});

describe('AzureWorkItemDescription', () => {
  it('renders Markdown headings, emphasis, links, and lists', () => {
    act(() => {
      root.render(
        <AzureWorkItemDescription content={'# Heading\n\n**Bold** and [link](https://example.com)\n\n- First\n- Second'} />,
      );
    });

    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com',
    );
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('preserves HTML formatting from existing work items', () => {
    act(() => {
      root.render(
        <AzureWorkItemDescription content="<p>Existing <strong>HTML</strong></p>" />,
      );
    });

    expect(container.querySelector('strong')?.textContent).toBe('HTML');
    expect(container.textContent).not.toContain('<p>');
  });

  it('keeps HTML examples inside Markdown code fences as code', () => {
    act(() => {
      root.render(
        <AzureWorkItemDescription content={'```html\n<p>Example</p>\n```'} />,
      );
    });

    expect(container.querySelector('code')?.textContent).toContain(
      '<p>Example</p>',
    );
    expect(container.querySelector('p')?.textContent).not.toBe('Example');
  });

  it('keeps authenticated images in Markdown descriptions', () => {
    act(() => {
      root.render(
        <AzureWorkItemDescription
          content={`![image.png](${ATTACHMENT_URL} =640x)`}
          providerId="provider-1"
        />,
      );
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toMatch(/^azure-image-proxy:\/\//);
    expect(image?.style.width).toBe('640px');
  });
});
